import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeContentScore } from "@/lib/recommendation";
import { buildConnectionsByUser, computeCollaborativeScores } from "@/lib/collaborative";
import { computeHybridWeights, computeHybridScore } from "@/lib/hybrid";
import { buildTrainingExamples, evaluateTemporalModel, evaluateTemporalRelevance, scoreCandidate, trainAcceptanceModel, trainRelevanceModel } from "@/lib/adaptive-recommender";
import { getAdaptivePredictions } from "@/lib/hosted-ml";
import { diversifyRankedCandidates } from "@/lib/profile-vectors";
import { getMlUserKey } from "@/lib/ml-sync-auth";
import { isEligibleMentorshipMatch } from "@/lib/matching-eligibility";
import { adminApiErrorResponse } from "@/lib/admin-api-error";
import { withNcfRankingSignal } from "@/lib/ncf-ranking";

const BENCHMARK_SAMPLE_SIZE = 150;
const EVALUATION_HISTORY_LIMIT = 10000;
const eligibleProfileWhere = {
  user: { isVerified: true, isSuspended: false, isDeleted: false, isDemo: false },
};
const profileIncludes = {
  user: { select: { id: true, role: true } },
  skills: { include: { skill: true } },
  interests: { include: { interest: true } },
  mentorshipTopics: { include: { skill: { select: { id: true, name: true } } } },
};

function stableProfileSample(profileIds, sampleSize) {
  return profileIds
    .map((id) => ({ id, key: createHash("sha256").update(id).digest("hex") }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(0, sampleSize)
    .map(({ id }) => id);
}

function candidateSignals(profile) {
  const skillIds = (profile.skills || []).map(({ skillId }) => skillId);
  const interestIds = (profile.interests || []).map(({ interestId }) => interestId);
  return [
    skillIds.length ? { skills: { some: { skillId: { in: skillIds } } } } : null,
    interestIds.length ? { interests: { some: { interestId: { in: interestIds } } } } : null,
    profile.department ? { department: profile.department } : null,
  ].filter(Boolean);
}

function compatibleMentorshipRoleFilter(profile) {
  if (profile.mentorshipRole === "MENTOR") return [{ mentorshipRole: { in: ["MENTEE", "BOTH"] } }, { mentorshipRole: null }];
  if (profile.mentorshipRole === "MENTEE") return [{ mentorshipRole: { in: ["MENTOR", "BOTH"] } }, { mentorshipRole: null }];
  return null;
}

// Helper: Discounted Cumulative Gain
function computeDCG(relevanceList) {
  return relevanceList.reduce((acc, rel, idx) => {
    return acc + (Math.pow(2, rel) - 1) / Math.log2(idx + 2);
  }, 0);
}

function evaluateMemberJudgedRanking(events, feedbackRows) {
  const ownerImpressions = new Map();
  const establishedAtImpression = new WeakMap();
  for (const event of [...events].sort((a, b) => a.createdAt - b.createdAt)) {
    const prior = ownerImpressions.get(event.ownerId) || 0;
    establishedAtImpression.set(event, prior >= 10);
    ownerImpressions.set(event.ownerId, prior + 1);
  }
  const eventsByRecommendation = new Map();
  for (const event of events) {
    const rows = eventsByRecommendation.get(event.recommendationId) || [];
    rows.push(event);
    eventsByRecommendation.set(event.recommendationId, rows);
  }

  const judged = feedbackRows.flatMap((feedback) => {
    const recommendationId = feedback.recommendationId || feedback.mentorshipRequest?.recommendationId;
    const history = eventsByRecommendation.get(recommendationId) || [];
    const impressionCutoff = feedback.mentorshipRequest?.createdAt || feedback.createdAt;
    const event = [...history].reverse().find((row) => row.createdAt <= impressionCutoff);
    return event ? [{ feedback, event }] : [];
  }).sort((a, b) => a.feedback.createdAt - b.feedback.createdAt);

  const holdoutSize = Math.max(1, Math.ceil(judged.length * 0.2));
  const holdout = judged.slice(Math.max(0, judged.length - holdoutSize));
  const groups = new Map();
  for (const row of holdout) {
    const memberStage = establishedAtImpression.get(row.event) ? "established" : "new";
    const key = `${row.event.ownerId}:${row.event.createdAt.toISOString()}:${memberStage}`;
    const group = groups.get(key) || { rows: [], memberStage };
    group.rows.push(row);
    groups.set(key, group);
  }

  const strategies = [
    ["Content-Based", "content"],
    ["Collaborative", "collaborative"],
    ["Profile Hybrid", "profileHybrid"],
    ["Learned Relevance", "relevanceProbability"],
  ];
  const totals = Object.fromEntries(strategies.map(([name]) => [name, { values: [], byStage: { new: [], established: [] } }]));
  for (const { rows, memberStage } of groups.values()) {
    if (rows.length < 2) continue;
    const cutoff = Math.min(5, rows.length);
    const ideal = [...rows].sort((a, b) => b.feedback.rating - a.feedback.rating)
      .slice(0, cutoff).map(({ feedback }) => feedback.rating);
    const idcg = computeDCG(ideal) || 1;
    for (const [name, scoreKey] of strategies) {
      const ranked = rows.filter(({ event }) => Number.isFinite(event.scores?.[scoreKey]))
        .sort((a, b) => eventScore(b.event, scoreKey) - eventScore(a.event, scoreKey))
        .slice(0, cutoff);
      if (ranked.length < 2) continue;
      const ndcg = computeDCG(ranked.map(({ feedback }) => feedback.rating)) / idcg;
      totals[name].values.push(ndcg);
      totals[name].byStage[memberStage].push(ndcg);
    }
  }

  const interval = (values, salt) => {
    if (values.length < 2) return null;
    let seed = Number.parseInt(createHash("sha256").update(salt).digest("hex").slice(0, 8), 16) || 1;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const samples = [];
    for (let iteration = 0; iteration < 500; iteration++) {
      let sum = 0;
      for (let index = 0; index < values.length; index++) sum += values[Math.floor(random() * values.length)];
      samples.push(sum / values.length);
    }
    samples.sort((a, b) => a - b);
    return [+(samples[12]).toFixed(3), +(samples[487]).toFixed(3)];
  };

  return {
    available: Object.values(totals).some(({ values }) => values.length > 0),
    feedbackExamples: judged.length,
    holdoutExamples: holdout.length,
    holdoutGroups: groups.size,
    metrics: Object.fromEntries(Object.entries(totals).map(([name, value]) => [name, {
      ndcgAt5: value.values.length ? +(value.values.reduce((sum, score) => sum + score, 0) / value.values.length).toFixed(3) : null,
      evaluatedGroups: value.values.length,
      confidenceInterval95: interval(value.values, name),
      byMemberHistory: Object.fromEntries(Object.entries(value.byStage).map(([stage, scores]) => [stage, {
        ndcgAt5: scores.length ? +(scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(3) : null,
        evaluatedGroups: scores.length,
      }])),
    }])),
    note: "Newest 20% of member-rated recommendation impressions; groups with at least two rated candidates. 95% intervals bootstrap judged groups; member history is new (<10 prior served items) or established. This measures ranking among rated items, not all impressions.",
  };
}

function eventScore(event, key) {
  return Number(event.scores?.[key]);
}

function summarizeRecommendationExposure(events, profiles, acceptedRequests) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recent = events.filter((event) => event.createdAt >= cutoff);
  const policyCounts = {};
  for (const event of recent) {
    const policy = event.policy || "LEGACY_DETERMINISTIC";
    policyCounts[policy] = (policyCounts[policy] || 0) + 1;
  }
  const acceptedCounts = new Map();
  for (const request of acceptedRequests) {
    acceptedCounts.set(request.senderId, (acceptedCounts.get(request.senderId) || 0) + 1);
    acceptedCounts.set(request.receiverId, (acceptedCounts.get(request.receiverId) || 0) + 1);
  }
  const perMember = new Map();
  for (const event of recent) {
    const id = event.recommendation?.matchedUserId;
    if (!id) continue;
    const entry = perMember.get(id) || { served: 0, weighted: 0 };
    entry.served++;
    entry.weighted += 1 / Math.log2(Math.max(2, (event.rank || 1) + 1));
    perMember.set(id, entry);
  }

  const groups = new Map();
  const add = (name, key) => {
    const group = groups.get(key) || { name, members: 0, exposedMembers: 0, impressions: 0, weightedExposure: 0 };
    group.members++;
    const exposure = perMember.get(name.userId);
    if (exposure) {
      group.exposedMembers++;
      group.impressions += exposure.served;
      group.weightedExposure += exposure.weighted;
    }
    groups.set(key, group);
  };
  for (const profile of profiles) {
    const userId = profile.user.id;
    const department = profile.department || "Unassigned";
    add({ userId }, `department:${department}`);
    const activity = (acceptedCounts.get(userId) || 0) > 0 ? "Prior accepted interaction" : "No prior accepted interaction";
    add({ userId }, `activity:${activity}`);
  }

  return {
    windowDays: 30,
    servedImpressions: recent.length,
    policyCounts,
    groups: [...groups.entries()]
      .filter(([, group]) => group.members >= 5)
      .map(([key, group]) => ({
        group: key.slice(key.indexOf(":") + 1),
        dimension: key.startsWith("department:") ? "department" : "accepted-interaction history",
        eligibleMembers: group.members,
        exposedMembers: group.exposedMembers,
        impressions: group.impressions,
        rankWeightedExposurePerMember: group.members ? +(group.weightedExposure / group.members).toFixed(3) : 0,
      })),
    note: "Exposure is a visibility diagnostic, not a fairness verdict. Groups with fewer than five eligible members are omitted.",
  };
}

// GET /api/admin/evaluation
// Computes Precision@K, Recall@K, NDCG@K, and MRR for CBF, CF, and Hybrid
// Also supports ?simulateUserId=<id> for live recommendation engine inspection
export async function GET(req) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Allow admins or test evaluation
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const startTime = Date.now();

  try {
    const url = new URL(req.url);
    const simulateUserId = url.searchParams.get("simulateUserId");

    const [eligibleProfileIndex, acceptedMentorships, acceptedConnections, resolvedMentorships, resolvedConnections, relevanceFeedback, modelArtifacts, recommendationEvents] = await Promise.all([
      prisma.profile.findMany({
        where: eligibleProfileWhere,
        select: { userId: true, department: true },
      }),
      prisma.mentorshipRequest.findMany({
        where: { status: "ACCEPTED", sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } } },
        select: { senderId: true, receiverId: true },
        orderBy: { createdAt: "desc" }, take: EVALUATION_HISTORY_LIMIT,
      }),
      prisma.connectionRequest.findMany({
        where: { status: "ACCEPTED", sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } } },
        select: { senderId: true, receiverId: true },
        orderBy: { createdAt: "desc" }, take: EVALUATION_HISTORY_LIMIT,
      }),
      prisma.mentorshipRequest.findMany({
        where: { status: { in: ["ACCEPTED", "DECLINED"] }, sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } } },
        select: { status: true, modelFeatures: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: EVALUATION_HISTORY_LIMIT,
      }),
      prisma.connectionRequest.findMany({
        where: { status: { in: ["ACCEPTED", "DECLINED"] }, sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } } },
        select: { status: true, modelFeatures: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: EVALUATION_HISTORY_LIMIT,
      }),
      prisma.feedback.findMany({
        where: {
          feedbackType: "MATCH_RELEVANCE",
          user: { isDemo: false, isDeleted: false },
          recommendation: { is: { owner: { isDemo: false, isDeleted: false }, matchedUser: { isDemo: false, isDeleted: false } } },
        },
        select: {
          rating: true,
          modelFeatures: true,
          recommendationId: true,
          createdAt: true,
          mentorshipRequest: { select: { createdAt: true, recommendationId: true } },
        },
        orderBy: { createdAt: "desc" },
        take: EVALUATION_HISTORY_LIMIT,
      }),
      prisma.mLModelArtifact.findMany({
        where: { OR: [{ active: true }, { type: "NCF" }] },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.recommendationEvent.findMany({
        where: {
          eventType: "SERVED",
          owner: { is: { isDemo: false, isDeleted: false } },
          recommendation: { is: { matchedUser: { is: { isDemo: false, isDeleted: false } } } },
        },
        orderBy: { createdAt: "desc" },
        take: EVALUATION_HISTORY_LIMIT,
        select: {
          ownerId: true,
          recommendationId: true,
          createdAt: true,
          rank: true,
          policy: true,
          selectionProbability: true,
          scores: true,
          recommendation: { select: { matchedUserId: true } },
        },
      }),
    ]);

    const totalStakeholders = eligibleProfileIndex.length;
    const sampleIds = stableProfileSample(eligibleProfileIndex.map(({ userId }) => userId), BENCHMARK_SAMPLE_SIZE);
    const profiles = sampleIds.length ? await prisma.profile.findMany({
      where: { userId: { in: sampleIds }, ...eligibleProfileWhere },
      include: profileIncludes,
    }) : [];

    const totalInteractions = acceptedMentorships.length + acceptedConnections.length;
    const connectionsByUser = buildConnectionsByUser([
      ...acceptedMentorships,
      ...acceptedConnections,
    ]);
    const trainingExamples = buildTrainingExamples([
      ...resolvedMentorships,
      ...resolvedConnections,
    ]);
    const model = trainAcceptanceModel(trainingExamples);
    const relevanceModel = trainRelevanceModel(relevanceFeedback);
    const latestNcfArtifact = modelArtifacts.find((artifact) => artifact.type === "NCF") || null;
    const ncfMemberKeys = new Set(Object.keys(latestNcfArtifact?.weights?.userEmbeddings || {}));
    const ncfKnownMembers = eligibleProfileIndex.filter(({ userId }) => ncfMemberKeys.has(getMlUserKey(userId))).length;
    const temporalEvaluation = evaluateTemporalModel([
      ...resolvedMentorships,
      ...resolvedConnections,
    ]);
    const relevanceEvaluation = evaluateTemporalRelevance(relevanceFeedback);
    const memberJudgedRanking = evaluateMemberJudgedRanking(recommendationEvents, relevanceFeedback);
    const recommendationExposure = summarizeRecommendationExposure(
      recommendationEvents,
      eligibleProfileIndex.map(({ userId, department }) => ({ user: { id: userId }, department })),
      [...acceptedMentorships, ...acceptedConnections]
    );
    const hybridWeights = computeHybridWeights(totalInteractions);
    const modelState = await getAdaptivePredictions({
      examples: trainingExamples,
      relevanceExamples: relevanceFeedback
        .filter((row) => row.modelFeatures && (row.rating >= 4 || row.rating <= 2))
        .map((row) => ({ features: row.modelFeatures, label: row.rating >= 4 ? 1 : 0 })),
      candidates: [],
      localModel: model,
      relevanceModel,
      artifacts: modelArtifacts,
    });

    // Live recommendation simulation for a selected stakeholder
    if (simulateUserId) {
      const targetProfile = profiles.find((p) => p.user.id === simulateUserId) || await prisma.profile.findFirst({
        where: { userId: simulateUserId, ...eligibleProfileWhere },
        include: profileIncludes,
      });
      if (!targetProfile) {
        return NextResponse.json({ error: "Target stakeholder not found" }, { status: 404 });
      }

      const targetAttrs = {
        skillIds: targetProfile.skills.map((s) => s.skillId),
        interestIds: targetProfile.interests.map((i) => i.interestId),
      };

      const skillLookup = await prisma.skill.findMany({ select: { id: true, name: true } });
      const skillMap = Object.fromEntries(skillLookup.map((s) => [s.id, s.name]));
      const targetSkillIds = new Set(targetAttrs.skillIds);

      const signalFilters = candidateSignals(targetProfile);
      const roleFilters = compatibleMentorshipRoleFilter(targetProfile);
      const simulationPool = await prisma.profile.findMany({
        where: {
          isPublic: true,
          userId: { not: simulateUserId },
          user: { isVerified: true, isSuspended: false, isDeleted: false, isDemo: false },
          ...(signalFilters.length ? { OR: signalFilters } : {}),
          ...(roleFilters ? { AND: [{ OR: roleFilters }] } : {}),
        },
        orderBy: { userId: "asc" },
        take: 250,
        include: profileIncludes,
      });
      const simEligibleProfiles = simulationPool.filter((p) => isEligibleMentorshipMatch(targetProfile, p));
      const simulationCollaborativeScores = computeCollaborativeScores(
        connectionsByUser,
        simulateUserId,
        simEligibleProfiles.map((profile) => profile.user.id)
      );
      const simResults = simEligibleProfiles
        .map((cand) => {
          const candAttrs = {
            skillIds: cand.skills.map((s) => s.skillId),
            interestIds: cand.interests.map((i) => i.interestId),
          };

          const cbf = computeContentScore(targetAttrs, candAttrs);
          const cf = simulationCollaborativeScores.get(cand.user.id) || 0;
          const adaptive = scoreCandidate({
            owner: targetProfile,
            candidate: cand,
            ownerAttrs: targetAttrs,
            candidateAttrs: candAttrs,
            connectionsByUser,
            collaborativeScoreOverride: simulationCollaborativeScores.get(cand.user.id),
            model,
            totalAcceptedInteractions: totalInteractions,
          });

          const sharedSkillNames = cand.skills
            .filter((s) => targetSkillIds.has(s.skillId))
            .map((s) => skillMap[s.skillId] || "Technical Skill");

          return {
            id: cand.user.id,
            name: cand.fullName || "Stakeholder",
            department: cand.department || "Operations",
            role: cand.user.role,
            contentScore: +(cbf * 100).toFixed(1),
            semanticScore: +(adaptive.semanticScore * 100).toFixed(1),
            collaborativeScore: +(cf * 100).toFixed(1),
            mlAcceptanceProbability: adaptive.mlAcceptanceProbability,
            baselineScore: adaptive.baselineScore,
            modelFeatures: adaptive.modelFeatures,
            matchScore: adaptive.matchScore,
            sharedSkills: sharedSkillNames,
          };
        });

      const hostedPredictions = await getAdaptivePredictions({
        examples: trainingExamples,
        relevanceExamples: relevanceFeedback
          .filter((row) => row.modelFeatures && (row.rating >= 4 || row.rating <= 2))
          .map((row) => ({ features: row.modelFeatures, label: row.rating >= 4 ? 1 : 0 })),
        candidates: simResults.map((item) => ({ features: item.modelFeatures })),
        ncfCandidates: simResults.map((item) => ({
          senderKey: getMlUserKey(targetProfile.user.id),
          recipientKey: getMlUserKey(item.id),
          features: item.modelFeatures,
        })),
        localModel: model,
        relevanceModel,
        artifacts: modelArtifacts,
      });
      const simulationNcfModel = hostedPredictions.ncfModel || { active: false, sampleCount: 0, confidence: 0 };
      const simulationNcfPredictions = hostedPredictions.ncfPredictions || simResults.map(() => null);
      const simulationRelevanceModel = hostedPredictions.relevanceModel || relevanceModel;
      const simulationRelevancePredictions = hostedPredictions.relevancePredictions || simResults.map(() => null);
      simResults.forEach((item, index) => {
        item.mlAcceptanceProbability = hostedPredictions.predictions[index];
        item.ncfProbability = simulationNcfPredictions[index];
        item.relevanceProbability = simulationRelevancePredictions[index];
        const relevanceInfluence = item.relevanceProbability === null ? 0 : simulationRelevanceModel.confidence;
        item.matchScore = item.relevanceProbability === null
          ? item.baselineScore
          : item.baselineScore * (1 - relevanceInfluence) + item.relevanceProbability * relevanceInfluence;
        Object.assign(item, withNcfRankingSignal(item, item.ncfProbability));
      });
      const rankedSimResults = diversifyRankedCandidates(simResults.sort((a, b) => b.rankingScore - a.rankingScore), 5);

      return NextResponse.json({
        simulation: {
          targetUser: {
            id: targetProfile.user.id,
            name: targetProfile.fullName || "Stakeholder",
            department: targetProfile.department || "Operations",
            role: targetProfile.user.role,
          },
          candidates: rankedSimResults.map(({ baselineScore, modelFeatures, ...item }) => ({
            ...item,
            mlAcceptanceProbability: item.mlAcceptanceProbability === null
              ? null
              : +(item.mlAcceptanceProbability * 100).toFixed(1),
            matchScore: +(item.matchScore * 100).toFixed(1),
            rankingScore: +(item.rankingScore * 100).toFixed(1),
            relevanceProbability: item.relevanceProbability === null ? null : +(item.relevanceProbability * 100).toFixed(1),
            ncfAcceptanceProbability: item.ncfProbability === null ? null : +(item.ncfProbability * 100).toFixed(1),
            ncfInfluence: +(item.ncfInfluence * 100).toFixed(1),
            diversityAdjustment: +(item.diversityAdjustment * 100).toFixed(1),
          })),
          model: {
            active: hostedPredictions.model.active,
            trainingExamples: hostedPredictions.model.sampleCount,
            acceptedExamples: hostedPredictions.model.acceptedCount,
            declinedExamples: hostedPredictions.model.declinedCount,
            confidence: Math.round(hostedPredictions.model.confidence * 100),
            featureWeights: hostedPredictions.model.weights,
            provider: hostedPredictions.provider,
            versions: {
              acceptance: hostedPredictions.model.version || null,
              relevance: simulationRelevanceModel.version || null,
            },
            trainedAt: hostedPredictions.model.createdAt || simulationRelevanceModel.createdAt || null,
            relevance: {
              active: simulationRelevanceModel.active,
              trainingExamples: simulationRelevanceModel.sampleCount,
              confidence: Math.round(simulationRelevanceModel.confidence * 100),
            },
            ncf: {
              active: simulationNcfModel.active,
              trainingExamples: simulationNcfModel.sampleCount,
              confidence: Math.round(simulationNcfModel.confidence * 100),
              version: simulationNcfModel.version || latestNcfArtifact?.version || null,
              evaluated: Boolean(latestNcfArtifact),
              latestEvaluationActive: latestNcfArtifact?.active ?? null,
              holdoutRocAuc: simulationNcfModel.metrics?.holdoutRocAuc ?? latestNcfArtifact?.metrics?.holdoutRocAuc ?? null,
              holdoutPrAuc: simulationNcfModel.metrics?.holdoutPrAuc ?? latestNcfArtifact?.metrics?.holdoutPrAuc ?? null,
              holdoutBrierScore: simulationNcfModel.metrics?.holdoutBrierScore ?? latestNcfArtifact?.metrics?.holdoutBrierScore ?? null,
              holdoutCoverage: simulationNcfModel.metrics?.holdoutCoverage ?? latestNcfArtifact?.metrics?.holdoutCoverage ?? null,
              holdoutCount: simulationNcfModel.metrics?.holdoutCount ?? latestNcfArtifact?.metrics?.holdoutCount ?? null,
              holdoutNdcgAt5: simulationNcfModel.metrics?.["ndcg@5"] ?? latestNcfArtifact?.metrics?.["ndcg@5"] ?? null,
              rankingInfluence: simulationNcfModel.active ? 10 : 0,
              knownMembers: ncfKnownMembers,
              unseenMembers: Math.max(0, totalStakeholders - ncfKnownMembers),
            },
          },
          latencyMs: Date.now() - startTime,
        },
      });
    }

    // Run benchmark across users with at least 2 candidates
    if (totalStakeholders < 3 || profiles.length < 3) {
      return NextResponse.json({
        message: "Not enough profiles to run benchmark",
        benchmark: null,
      });
    }

    let cbfPrec5 = 0, cfPrec5 = 0, hybridPrec5 = 0;
    let cbfRec5 = 0, cfRec5 = 0, hybridRec5 = 0;
    let cbfNdcg10 = 0, cfNdcg10 = 0, hybridNdcg10 = 0;
    let cbfMrr = 0, cfMrr = 0, hybridMrr = 0;
    let evaluatedUsersCount = 0;

    for (const userProfile of profiles) {
      const userId = userProfile.user.id;
      const candidates = profiles.filter((p) => p.user.id !== userId);
      const collaborativeScores = computeCollaborativeScores(
        connectionsByUser,
        userId,
        candidates.map((candidate) => candidate.user.id)
      );

      const userSkillIds = new Set(userProfile.skills.map((s) => s.skillId));

      // Ground truth relevant set: shared skills >= 2 OR connected
      const relevantCandidateIds = new Set(
        candidates
          .filter((c) => {
            const sharedCount = c.skills.filter((s) => userSkillIds.has(s.skillId)).length;
            const isConnected = connectionsByUser.get(userId)?.has(c.user.id) || false;
            return sharedCount >= 2 || isConnected;
          })
          .map((c) => c.user.id)
      );

      if (relevantCandidateIds.size === 0) continue;

      evaluatedUsersCount++;
      const totalRelevant = relevantCandidateIds.size;

      // Score all candidates
      const scoredCandidates = candidates.map((cand) => {
        const ownerAttrs = {
          skillIds: userProfile.skills.map((s) => s.skillId),
          interestIds: userProfile.interests.map((i) => i.interestId),
        };
        const candAttrs = {
          skillIds: cand.skills.map((s) => s.skillId),
          interestIds: cand.interests.map((i) => i.interestId),
        };

        const cbf = computeContentScore(ownerAttrs, candAttrs);
        const cf = collaborativeScores.get(cand.user.id) || 0;
        const hybrid = computeHybridScore(cbf, cf, hybridWeights);

        return {
          id: cand.user.id,
          cbf,
          cf,
          hybrid,
          isRelevant: relevantCandidateIds.has(cand.user.id) ? 1 : 0,
        };
      });

      // Rank by CBF
      const rankCbf = [...scoredCandidates].sort((a, b) => b.cbf - a.cbf);
      // Rank by CF
      const rankCf = [...scoredCandidates].sort((a, b) => b.cf - a.cf);
      // Rank by Hybrid
      const rankHybrid = [...scoredCandidates].sort((a, b) => b.hybrid - a.hybrid);

      // Top 5 metrics
      const top5CbfRel = rankCbf.slice(0, 5).filter((x) => x.isRelevant).length;
      const top5CfRel = rankCf.slice(0, 5).filter((x) => x.isRelevant).length;
      const top5HybridRel = rankHybrid.slice(0, 5).filter((x) => x.isRelevant).length;

      const precisionCutoff = Math.min(5, candidates.length);
      cbfPrec5 += top5CbfRel / precisionCutoff;
      cfPrec5 += top5CfRel / precisionCutoff;
      hybridPrec5 += top5HybridRel / precisionCutoff;

      cbfRec5 += top5CbfRel / totalRelevant;
      cfRec5 += top5CfRel / totalRelevant;
      hybridRec5 += top5HybridRel / totalRelevant;

      // NDCG@10
      const idealRelevance = Array(totalRelevant).fill(1).concat(Array(Math.max(0, 10 - totalRelevant)).fill(0)).slice(0, 10);
      const idcg = computeDCG(idealRelevance) || 1;

      cbfNdcg10 += computeDCG(rankCbf.slice(0, 10).map((x) => x.isRelevant)) / idcg;
      cfNdcg10 += computeDCG(rankCf.slice(0, 10).map((x) => x.isRelevant)) / idcg;
      hybridNdcg10 += computeDCG(rankHybrid.slice(0, 10).map((x) => x.isRelevant)) / idcg;

      // MRR
      const cbfFirstRelIdx = rankCbf.findIndex((x) => x.isRelevant);
      if (cbfFirstRelIdx !== -1) cbfMrr += 1 / (cbfFirstRelIdx + 1);

      const cfFirstRelIdx = rankCf.findIndex((x) => x.isRelevant);
      if (cfFirstRelIdx !== -1) cfMrr += 1 / (cfFirstRelIdx + 1);

      const hybridFirstRelIdx = rankHybrid.findIndex((x) => x.isRelevant);
      if (hybridFirstRelIdx !== -1) hybridMrr += 1 / (hybridFirstRelIdx + 1);
    }

    const n = Math.max(evaluatedUsersCount, 1);

    const benchmark = {
      evaluatedUsers: evaluatedUsersCount,
      totalStakeholders,
      sampledProfiles: profiles.length,
      benchmarkSampleSize: BENCHMARK_SAMPLE_SIZE,
      benchmarkSampling: "Deterministic SHA-256 sample of eligible real profiles",
      totalInteractions,
      adaptiveModel: {
        active: modelState.model.active,
        provider: modelState.provider,
        trainingExamples: modelState.model.sampleCount,
        acceptedExamples: modelState.model.acceptedCount,
        declinedExamples: modelState.model.declinedCount,
        confidence: Math.round(modelState.model.confidence * 100),
        featureWeights: modelState.model.weights,
        version: modelState.model.version || modelState.relevanceModel.version || null,
        trainedAt: modelState.model.createdAt || modelState.relevanceModel.createdAt || null,
        relevance: {
          active: modelState.relevanceModel.active,
          trainingExamples: modelState.relevanceModel.sampleCount,
          positiveExamples: modelState.relevanceModel.acceptedCount,
          negativeExamples: modelState.relevanceModel.declinedCount,
          confidence: Math.round(modelState.relevanceModel.confidence * 100),
        },
        ncf: {
          active: modelState.ncfModel.active,
          trainingExamples: modelState.ncfModel.active ? modelState.ncfModel.sampleCount : latestNcfArtifact?.sampleCount || 0,
          confidence: Math.round(modelState.ncfModel.confidence * 100),
          version: modelState.ncfModel.version || latestNcfArtifact?.version || null,
          evaluated: Boolean(latestNcfArtifact),
          latestEvaluationActive: latestNcfArtifact?.active ?? null,
          holdoutRocAuc: modelState.ncfModel.metrics?.holdoutRocAuc ?? latestNcfArtifact?.metrics?.holdoutRocAuc ?? null,
          holdoutPrAuc: modelState.ncfModel.metrics?.holdoutPrAuc ?? latestNcfArtifact?.metrics?.holdoutPrAuc ?? null,
          holdoutBrierScore: modelState.ncfModel.metrics?.holdoutBrierScore ?? latestNcfArtifact?.metrics?.holdoutBrierScore ?? null,
          holdoutCoverage: modelState.ncfModel.metrics?.holdoutCoverage ?? latestNcfArtifact?.metrics?.holdoutCoverage ?? null,
          holdoutCount: modelState.ncfModel.metrics?.holdoutCount ?? latestNcfArtifact?.metrics?.holdoutCount ?? null,
          holdoutNdcgAt5: modelState.ncfModel.metrics?.["ndcg@5"] ?? latestNcfArtifact?.metrics?.["ndcg@5"] ?? null,
          knownMembers: ncfKnownMembers,
          unseenMembers: Math.max(0, totalStakeholders - ncfKnownMembers),
        },
      },
      temporalEvaluation,
      relevanceEvaluation,
      memberJudgedRanking,
      recommendationExposure,
      memberFeedback: {
        total: relevanceFeedback.length,
        useful: relevanceFeedback.filter((row) => row.rating >= 4).length,
        notUseful: relevanceFeedback.filter((row) => row.rating <= 2).length,
        evaluationWindow: `Most recent ${EVALUATION_HISTORY_LIMIT} rows per history source`,
      },
      weights: {
        alpha: Math.round(hybridWeights.alpha * 100),
        beta: Math.round(hybridWeights.beta * 100),
      },
      latencyMs: Date.now() - startTime,
      upliftPercent: +(
        ((hybridNdcg10 - Math.max(cbfNdcg10, cfNdcg10, 0.001)) /
          Math.max(cbfNdcg10, cfNdcg10, 0.001)) *
        100
      ).toFixed(1),
      models: [
        {
          name: "Content-Based (CBF)",
          precisionAt5: +(cbfPrec5 / n).toFixed(3),
          recallAt5: +(cbfRec5 / n).toFixed(3),
          ndcgAt10: +(cbfNdcg10 / n).toFixed(3),
          mrr: +(cbfMrr / n).toFixed(3),
        },
        {
          name: "Collaborative (CF)",
          precisionAt5: +(cfPrec5 / n).toFixed(3),
          recallAt5: +(cfRec5 / n).toFixed(3),
          ndcgAt10: +(cfNdcg10 / n).toFixed(3),
          mrr: +(cfMrr / n).toFixed(3),
        },
        {
          name: "Hybrid (CBF + CF)",
          precisionAt5: +(hybridPrec5 / n).toFixed(3),
          recallAt5: +(hybridRec5 / n).toFixed(3),
          ndcgAt10: +(hybridNdcg10 / n).toFixed(3),
          mrr: +(hybridMrr / n).toFixed(3),
        },
      ],
    };

    const bestNdcg = Math.max(...benchmark.models.map((model) => model.ndcgAt10));
    benchmark.models = benchmark.models.map((model) => ({
      ...model,
      isBest: model.ndcgAt10 === bestNdcg,
    }));

    return NextResponse.json({ benchmark });
  } catch (err) {
    return adminApiErrorResponse("Admin evaluation", err);
  }
}
