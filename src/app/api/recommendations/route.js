import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sharedAttributes } from "@/lib/recommendation";
import { buildConnectionsByUser, computeCollaborativeScores } from "@/lib/collaborative";
import {
  buildTrainingExamples,
  scoreCandidate,
  trainAcceptanceModel,
  trainRelevanceModel,
} from "@/lib/adaptive-recommender";
import { getAdaptivePredictions } from "@/lib/hosted-ml";
import { diversifyRankedCandidates, explainProfileMatch } from "@/lib/profile-vectors";
import { getMlUserKey } from "@/lib/ml-sync-auth";
import { isEligibleMentorshipMatch } from "@/lib/matching-eligibility";
import { withNcfRankingSignal } from "@/lib/ncf-ranking";
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";

const CANDIDATE_PREFETCH_SIZE = 750;
const INTERACTION_HISTORY_LIMIT = 5000;

// GET /api/recommendations
// Fits a small acceptance model from resolved, feature-snapshotted live
// requests. Its prediction is displayed separately and does not rank matches.
export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const ownerProfile = await prisma.profile.findUnique({
    where: { userId: session.user.id },
    include: {
      skills: { include: { skill: true } },
      interests: { include: { interest: true } },
      mentorshipTopics: { include: { skill: { select: { id: true, name: true } } } },
    },
  });

  if (!ownerProfile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const ownerAttrs = {
    skillIds: ownerProfile.skills.map((item) => item.skillId),
    interestIds: ownerProfile.interests.map((item) => item.interestId),
  };

  const dismissedEvents = await prisma.recommendationEvent.findMany({
    where: {
      ownerId: session.user.id,
      eventType: "DISMISS",
      createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: "desc" },
    take: 2000,
    select: { recommendation: { select: { matchedUserId: true } } },
  });
  const dismissedUserIds = [...new Set(dismissedEvents.map((event) => event.recommendation.matchedUserId))];
  const signalClauses = [];
  if (ownerAttrs.skillIds.length) signalClauses.push(Prisma.sql`EXISTS (
    SELECT 1 FROM "ProfileSkill" ps WHERE ps."profileId" = p.id AND ps."skillId" IN (${Prisma.join(ownerAttrs.skillIds)})
  )`);
  if (ownerAttrs.interestIds.length) signalClauses.push(Prisma.sql`EXISTS (
    SELECT 1 FROM "ProfileInterest" pi WHERE pi."profileId" = p.id AND pi."interestId" IN (${Prisma.join(ownerAttrs.interestIds)})
  )`);
  if (ownerProfile.department) signalClauses.push(Prisma.sql`p.department = ${ownerProfile.department}`);
  const signalClause = signalClauses.length ? Prisma.sql`AND (${Prisma.join(signalClauses, " OR ")})` : Prisma.empty;
  const roleClause = ownerProfile.mentorshipRole === "MENTOR"
    ? Prisma.sql`AND (p."mentorshipRole" IN ('MENTEE', 'BOTH') OR p."mentorshipRole" IS NULL)`
    : ownerProfile.mentorshipRole === "MENTEE"
      ? Prisma.sql`AND (p."mentorshipRole" IN ('MENTOR', 'BOTH') OR p."mentorshipRole" IS NULL)`
      : Prisma.empty;
  const dismissedClause = dismissedUserIds.length
    ? Prisma.sql`AND p."userId" NOT IN (${Prisma.join(dismissedUserIds)})`
    : Prisma.empty;
  const skillOverlap = ownerAttrs.skillIds.length ? Prisma.sql`(
    SELECT COUNT(*) FROM "ProfileSkill" ps WHERE ps."profileId" = p.id AND ps."skillId" IN (${Prisma.join(ownerAttrs.skillIds)})
  )` : Prisma.sql`0`;
  const interestOverlap = ownerAttrs.interestIds.length ? Prisma.sql`(
    SELECT COUNT(*) FROM "ProfileInterest" pi WHERE pi."profileId" = p.id AND pi."interestId" IN (${Prisma.join(ownerAttrs.interestIds)})
  )` : Prisma.sql`0`;
  const rotationKey = `${session.user.id}:${new Date().toISOString().slice(0, 10)}`;
  const candidateIds = await prisma.$queryRaw(Prisma.sql`
    SELECT p."userId" AS "userId"
    FROM "Profile" p JOIN "User" u ON u.id = p."userId"
    WHERE p."isPublic" = true AND p."userId" <> ${session.user.id}
      AND u."isVerified" = true AND u."isSuspended" = false AND u."isDeleted" = false AND u."isDemo" = false
      ${dismissedClause} ${roleClause} ${signalClause}
    ORDER BY (${skillOverlap} * 3 + ${interestOverlap} * 2 + CASE WHEN p.department = ${ownerProfile.department || null} THEN 1 ELSE 0 END) DESC,
      md5(p."userId" || ${rotationKey}) ASC
    LIMIT ${CANDIDATE_PREFETCH_SIZE}
  `);
  const candidates = candidateIds.length ? await prisma.profile.findMany({
    where: { userId: { in: candidateIds.map(({ userId }) => userId) } },
    include: {
      user: { select: { id: true, role: true } },
      skills: { include: { skill: true } },
      interests: { include: { interest: true } },
      mentorshipTopics: { include: { skill: { select: { id: true, name: true } } } },
    },
  }) : [];
  const eligibleCandidates = candidates.filter((candidate) => isEligibleMentorshipMatch(ownerProfile, candidate));

  const [acceptedMentorships, acceptedConnections, resolvedMentorships, resolvedConnections] = await Promise.all([
    prisma.mentorshipRequest.findMany({
      where: { status: "ACCEPTED", sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } } },
      select: { senderId: true, receiverId: true },
      orderBy: { createdAt: "desc" }, take: INTERACTION_HISTORY_LIMIT,
    }),
    prisma.connectionRequest.findMany({
      where: { status: "ACCEPTED", sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } } },
      select: { senderId: true, receiverId: true },
      orderBy: { createdAt: "desc" }, take: INTERACTION_HISTORY_LIMIT,
    }),
    prisma.mentorshipRequest.findMany({
      where: { status: { in: ["ACCEPTED", "DECLINED"] }, sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } } },
      select: { status: true, modelFeatures: true },
      orderBy: { createdAt: "desc" }, take: INTERACTION_HISTORY_LIMIT,
    }),
    prisma.connectionRequest.findMany({
      where: { status: { in: ["ACCEPTED", "DECLINED"] }, sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } } },
      select: { status: true, modelFeatures: true },
      orderBy: { createdAt: "desc" }, take: INTERACTION_HISTORY_LIMIT,
    }),
  ]);

  const connectionsByUser = buildConnectionsByUser([
    ...acceptedMentorships,
    ...acceptedConnections,
  ]);
  const examples = buildTrainingExamples([
    ...resolvedMentorships,
    ...resolvedConnections,
  ]);
  const model = trainAcceptanceModel(examples);
  const feedbackRows = await prisma.feedback.findMany({
    where: {
      feedbackType: "MATCH_RELEVANCE",
      userId: session.user.id,
      user: { isDemo: false, isDeleted: false },
      recommendation: { is: { owner: { isDemo: false, isDeleted: false }, matchedUser: { isDemo: false, isDeleted: false } } },
    },
    orderBy: { createdAt: "desc" },
    take: 1000,
    select: { rating: true, modelFeatures: true, recommendation: { select: { matchedUserId: true } } },
  });
  const relevanceModel = trainRelevanceModel(feedbackRows);
  const modelArtifacts = await prisma.mLModelArtifact.findMany({
    where: { active: true },
    orderBy: { createdAt: "desc" },
  });
  const totalInteractions = acceptedMentorships.length + acceptedConnections.length;
  const collaborativeScores = computeCollaborativeScores(
    connectionsByUser,
    session.user.id,
    eligibleCandidates.map((candidate) => candidate.user.id)
  );

  const scored = eligibleCandidates.map((candidate) => {
    const candidateAttrs = {
      skillIds: candidate.skills.map((item) => item.skillId),
      interestIds: candidate.interests.map((item) => item.interestId),
    };
    const score = scoreCandidate({
      owner: ownerProfile,
      candidate,
      ownerAttrs,
      candidateAttrs,
      connectionsByUser,
      collaborativeScoreOverride: collaborativeScores.get(candidate.user.id),
      model,
      totalAcceptedInteractions: totalInteractions,
    });
    const { sharedSkillIds, sharedInterestIds } = sharedAttributes(
      ownerAttrs,
      candidateAttrs
    );

    return {
      candidate,
      ...score,
      sharedSkillNames: candidate.skills
        .filter((item) => sharedSkillIds.includes(item.skillId))
        .map((item) => item.skill.name),
      sharedInterestNames: candidate.interests
        .filter((item) => sharedInterestIds.includes(item.interestId))
        .map((item) => item.interest.name),
      matchReasons: explainProfileMatch(ownerProfile, candidate, score.modelFeatures),
    };
  });

  const hostedPredictions = await getAdaptivePredictions({
    examples,
    relevanceExamples: feedbackRows
      .filter((row) => row.modelFeatures && (row.rating >= 4 || row.rating <= 2))
      .map((row) => ({ features: row.modelFeatures, label: row.rating >= 4 ? 1 : 0 })),
    candidates: scored.map((item) => ({ features: item.modelFeatures })),
    ncfCandidates: scored.map((item) => ({
      senderKey: getMlUserKey(session.user.id),
      recipientKey: getMlUserKey(item.candidate.user.id),
      features: item.modelFeatures,
    })),
    localModel: model,
    relevanceModel,
    artifacts: modelArtifacts,
  });
  const relevanceOutput = hostedPredictions.relevanceModel || relevanceModel;
  const ncfOutput = hostedPredictions.ncfModel || { active: false, sampleCount: 0, acceptedCount: 0, declinedCount: 0, confidence: 0 };
  const ncfPredictions = hostedPredictions.ncfPredictions || scored.map(() => null);
  const relevancePredictions = hostedPredictions.relevancePredictions || scored.map(({ modelFeatures }) =>
    relevanceModel.active ? relevanceModel.predict(modelFeatures) : null
  );
  scored.forEach((item, index) => {
    item.mlAcceptanceProbability = hostedPredictions.predictions[index];
    item.mlConfidence = hostedPredictions.model.confidence;
    item.ncfProbability = ncfPredictions[index];
    item.mlRelevanceProbability = relevancePredictions[index];
    item.relevanceInfluence = item.mlRelevanceProbability === null
      ? 0
      : relevanceOutput.confidence;
    // Rank on profile/network fit, optionally blended with direct match ratings.
    // Request acceptance predictions remain a separate, descriptive signal.
    item.matchScore = item.mlRelevanceProbability === null
      ? item.baselineScore
      : item.baselineScore * (1 - item.relevanceInfluence) +
        item.mlRelevanceProbability * item.relevanceInfluence;
    Object.assign(item, withNcfRankingSignal(item, item.ncfProbability));
  });

  const diversifiedAll = diversifyRankedCandidates(
    [...scored].sort((a, b) => b.rankingScore - a.rankingScore),
    scored.length
  );
  let rankedCandidates = diversifiedAll.slice(0, 12).map((item) => ({ ...item, exploration: false, selectionProbability: 1 }));
  const explorationPool = diversifiedAll.filter((item) => !rankedCandidates.some((selected) => selected.candidate.user.id === item.candidate.user.id));
  const [servedHistoryCount, usefulFeedbackCount] = await Promise.all([
    prisma.recommendationEvent.count({
      where: {
        eventType: "SERVED",
        owner: { is: { isDemo: false, isDeleted: false } },
        recommendation: { is: { matchedUser: { is: { isDemo: false, isDeleted: false } } } },
      },
    }),
    prisma.feedback.count({
      where: {
        user: { isDemo: false, isDeleted: false },
        OR: [{ rating: { gte: 4 } }, { rating: { lte: 2 } }],
        AND: [{
          OR: [
            { recommendation: { is: { owner: { is: { isDemo: false, isDeleted: false } }, matchedUser: { is: { isDemo: false, isDeleted: false } } } } },
            { mentorshipRequest: { is: { sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } } } } },
          ],
        }],
      },
    }),
  ]);
  const explorationEnabled = process.env.RECOMMENDATION_EXPLORATION_ENABLED === "true" &&
    servedHistoryCount >= 500 && usefulFeedbackCount >= 100 && rankedCandidates.length >= 12 && explorationPool.length > 0;
  if (explorationEnabled) {
    const selectedIndex = randomInt(explorationPool.length);
    const selected = explorationPool[selectedIndex];
    rankedCandidates[11] = {
      ...selected,
      diversityAdjustment: 0,
      exploration: true,
      selectionProbability: 1 / explorationPool.length,
    };
  }
  const savedRecommendations = await prisma.$transaction(
    rankedCandidates.map(({ candidate, contentScore, collaborativeScore, semanticScore, matchScore, modelFeatures }, index) =>
      prisma.recommendation.upsert({
        where: { ownerId_matchedUserId: { ownerId: session.user.id, matchedUserId: candidate.user.id } },
        update: { contentScore, collaborativeScore, semanticScore, hybridScore: matchScore, modelFeatures, rank: index + 1 },
        create: {
          ownerId: session.user.id,
          matchedUserId: candidate.user.id,
          contentScore,
          collaborativeScore,
          semanticScore,
          hybridScore: matchScore,
          modelFeatures,
          rank: index + 1,
        },
      })
    )
  );

  const recommendationIds = new Map(savedRecommendations.map((row) => [row.matchedUserId, row.id]));
  await prisma.recommendationEvent.createMany({
    data: rankedCandidates.map((item, index) => ({
      ownerId: session.user.id,
      recommendationId: recommendationIds.get(item.candidate.user.id),
      eventType: "SERVED",
      rank: index + 1,
      policy: item.exploration ? "RANDOM_QUALIFIED_LAST_SLOT_V1" : item.ncfInfluence > 0 ? "NCF_ASSISTED_PROFILE_RANKING_V1" : "DETERMINISTIC_PROFILE_RELEVANCE_V3",
      selectionProbability: item.selectionProbability,
      scores: {
        content: item.contentScore,
        semantic: item.semanticScore,
        collaborative: item.collaborativeScore,
        profileHybrid: item.baselineScore,
        acceptanceProbability: item.mlAcceptanceProbability,
        relevanceProbability: item.mlRelevanceProbability,
        ncfAcceptanceProbability: item.ncfProbability,
        rankingScore: item.rankingScore,
        ncfRankingInfluence: item.ncfInfluence,
      },
    })),
  });
  const feedbackByCandidate = new Map(feedbackRows.map((row) => [row.recommendation?.matchedUserId, row.rating]));
  const ranked = rankedCandidates
    .map((item) => ({
      recommendationId: recommendationIds.get(item.candidate.user.id),
      feedbackRating: feedbackByCandidate.get(item.candidate.user.id) ?? null,
      userId: item.candidate.user.id,
      role: item.candidate.user.role,
      fullName: item.candidate.fullName,
      department: item.candidate.department,
      bio: item.candidate.bio,
      mentorshipRole: item.candidate.mentorshipRole,
      matchPercent: Math.round(item.matchScore * 100),
      profileRelevancePercent: Math.round(item.matchScore * 100),
      rankAdjustedPercent: Math.round((item.rankingScore - item.diversityAdjustment) * 100),
      rankingPercent: Math.round((item.rankingScore - item.diversityAdjustment) * 100),
      contentScore: Math.round(item.contentScore * 100),
      semanticScore: Math.round(item.semanticScore * 100),
      collaborativeScore: Math.round(item.collaborativeScore * 100),
      relevanceProbability: item.mlRelevanceProbability === null ? null : Math.round(item.mlRelevanceProbability * 100),
      relevanceInfluence: Math.round(item.relevanceInfluence * 100),
      diversityAdjustment: Math.round(item.diversityAdjustment * 100),
      mlAcceptanceProbability: item.mlAcceptanceProbability === null
        ? null
        : Math.round(item.mlAcceptanceProbability * 100),
      mlInfluence: Math.round(item.mlConfidence * 100),
      ncfAcceptanceProbability: item.ncfProbability === null ? null : Math.round(item.ncfProbability * 100),
      ncfInfluence: Math.round(item.ncfInfluence * 100),
      signals: {
        skillOverlap: Math.round((Number(item.modelFeatures.skillOverlap) || 0) * 100),
        interestOverlap: Math.round((Number(item.modelFeatures.interestOverlap) || 0) * 100),
        profileTextAlignment: Math.round((Number(item.modelFeatures.semanticProfileOverlap) || 0) * 100),
        sameDepartment: Boolean(item.modelFeatures.sameDepartment),
        mentorshipRoleFit: Boolean(item.modelFeatures.mentorshipRoleFit),
        sharedNetwork: Math.round((Number(item.modelFeatures.sharedNetwork) || 0) * 100),
        requestType: item.modelFeatures.isMentorshipRequest ? "Mentorship" : "Connection",
        mentorshipTopicFit: Math.round((Number(item.modelFeatures.mentorshipTopicFit) || 0) * 100),
      },
      sharedSkills: item.sharedSkillNames,
      sharedInterests: item.sharedInterestNames,
      matchReasons: item.matchReasons,
    }));

  return NextResponse.json({
    recommendations: ranked,
    meta: {
      totalInteractions,
      model: {
        active: hostedPredictions.model.active,
        provider: hostedPredictions.provider,
        trainingExamples: hostedPredictions.model.sampleCount,
        acceptedExamples: hostedPredictions.model.acceptedCount,
        declinedExamples: hostedPredictions.model.declinedCount,
        confidence: Math.round(hostedPredictions.model.confidence * 100),
        status: hostedPredictions.model.active ? "LEARNING_FROM_OUTCOMES" : "GATHERING_OUTCOMES",
      },
      relevanceModel: {
        active: relevanceOutput.active,
        trainingExamples: relevanceOutput.sampleCount,
        confidence: Math.round(relevanceOutput.confidence * 100),
        status: relevanceOutput.active ? "LEARNING_FROM_MEMBER_FEEDBACK" : "GATHERING_FEEDBACK",
      },
      ncfModel: {
        ...ncfOutput,
        confidence: Math.round(ncfOutput.confidence * 100),
      },
      ranking: {
        semanticProfileSignal: true,
        diversityReranking: true,
        acceptanceUsedForRanking: false,
        ncfStatus: ncfOutput.active ? "ASSISTED_RANKING" : "WAITING_FOR_ACTIVE_ARTIFACT",
        ncfRankingInfluence: rankedCandidates.some((item) => item.ncfInfluence > 0) ? 10 : 0,
        relevanceRankingInfluence: Math.round(Math.max(0, ...rankedCandidates.map((item) => item.relevanceInfluence || 0)) * 100),
        explorationEnabled,
        explorationHistory: { servedImpressions: servedHistoryCount, usefulFeedback: usefulFeedbackCount },
        version: "profile-feedback-ranker-v4",
      },
    },
  });
}
