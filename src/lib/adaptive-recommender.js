import { computeContentScore } from "./recommendation";
import { computeCollaborativeScore } from "./collaborative";
import { computeHybridScore, computeHybridWeights } from "./hybrid";
import { profileSemanticSimilarity } from "./profile-vectors";
import { availabilityPairFeatures } from "./availability";

export const FEATURE_NAMES = [
  "skillOverlap",
  "interestOverlap",
  "sameDepartment",
  "mentorshipRoleFit",
  "mentorshipTopicFit",
  "sharedNetwork",
  "isMentorshipRequest",
  "semanticProfileOverlap",
  "availabilityDayOverlap",
  "availabilityTimeOverlap",
  "availabilityFrequencyFit",
  "availabilityPairKnown",
];
const MIN_TRAINING_ROWS = 12;
const MIN_PER_CLASS = 4;
const FULL_INFLUENCE_ROWS = 50;

function overlap(idsA, idsB) {
  const a = new Set(idsA || []);
  const b = new Set(idsB || []);
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const id of a) if (b.has(id)) shared++;
  return shared / new Set([...a, ...b]).size;
}

function mentorshipTopicFit(profileA, profileB) {
  const topics = (profile, direction) => new Set(
    (profile.mentorshipTopics || [])
      .filter((topic) => topic.direction === direction)
      .map((topic) => topic.skillId)
  );
  const ownerSeeking = topics(profileA, "SEEKING");
  const candidateOffering = topics(profileB, "OFFERING");
  const candidateSeeking = topics(profileB, "SEEKING");
  const ownerOffering = topics(profileA, "OFFERING");
  const fits = [];
  if (ownerSeeking.size) fits.push(overlap([...ownerSeeking], [...candidateOffering]));
  if (candidateSeeking.size) fits.push(overlap([...candidateSeeking], [...ownerOffering]));
  return fits.length ? fits.reduce((sum, value) => sum + value, 0) / fits.length : 0;
}

function roleFit(senderRole, recipientRole) {
  const senderCanMentor = senderRole === "MENTOR" || senderRole === "BOTH";
  const senderCanLearn = senderRole === "MENTEE" || senderRole === "BOTH";
  const recipientCanMentor = recipientRole === "MENTOR" || recipientRole === "BOTH";
  const recipientCanLearn = recipientRole === "MENTEE" || recipientRole === "BOTH";
  return Number((senderCanLearn && recipientCanMentor) || (senderCanMentor && recipientCanLearn));
}

/** Features are captured when a request is sent, before its outcome is known. */
export function extractPairFeatures(sender, recipient, requestType, sharedNetwork = 0) {
  const senderSkillIds = (sender.skills || []).map((item) => item.skillId);
  const recipientSkillIds = (recipient.skills || []).map((item) => item.skillId);
  const senderInterestIds = (sender.interests || []).map((item) => item.interestId);
  const recipientInterestIds = (recipient.interests || []).map((item) => item.interestId);
  const senderRole = sender.mentorshipRole;
  const recipientRole = recipient.mentorshipRole;
  const mentorshipRoleFit = roleFit(senderRole, recipientRole);

  return {
    skillOverlap: overlap(senderSkillIds, recipientSkillIds),
    interestOverlap: overlap(senderInterestIds, recipientInterestIds),
    sameDepartment:
      sender.department && recipient.department &&
      sender.department.toLowerCase() === recipient.department.toLowerCase()
        ? 1
        : 0,
    mentorshipRoleFit: requestType === "MENTORSHIP" ? mentorshipRoleFit : 0,
    mentorshipTopicFit: requestType === "MENTORSHIP" ? mentorshipTopicFit(sender, recipient) : 0,
    sharedNetwork: Math.max(0, Math.min(1, sharedNetwork)),
    isMentorshipRequest: requestType === "MENTORSHIP" ? 1 : 0,
    semanticProfileOverlap: profileSemanticSimilarity(sender, recipient),
    ...availabilityPairFeatures(sender.availability, recipient.availability),
  };
}

function sigmoid(value) {
  if (value < -30) return 0;
  if (value > 30) return 1;
  return 1 / (1 + Math.exp(-value));
}

/** Small L2-regularized logistic regression trained on resolved live requests. */
function trainBinaryModel(examples, { minimumRows = MIN_TRAINING_ROWS, minimumPerClass = MIN_PER_CLASS } = {}) {
  const accepted = examples.filter((example) => example.label === 1).length;
  const declined = examples.length - accepted;
  if (
    examples.length < minimumRows ||
    accepted < minimumPerClass ||
    declined < minimumPerClass
  ) {
    return {
      active: false,
      sampleCount: examples.length,
      acceptedCount: accepted,
      declinedCount: declined,
      confidence: 0,
      predict: () => 0.5,
    };
  }

  const weights = Array(FEATURE_NAMES.length).fill(0);
  let bias = 0;
  const acceptedWeight = examples.length / (2 * accepted);
  const declinedWeight = examples.length / (2 * declined);

  // Full-batch gradient descent keeps this small model deterministic and fast.
  for (let epoch = 0; epoch < 500; epoch++) {
    const gradients = Array(FEATURE_NAMES.length).fill(0);
    let biasGradient = 0;
    for (const example of examples) {
      const features = FEATURE_NAMES.map((name) => Number(example.features?.[name]) || 0);
      const probability = sigmoid(
        bias + features.reduce((sum, value, index) => sum + value * weights[index], 0)
      );
      const classWeight = example.label === 1 ? acceptedWeight : declinedWeight;
      const error = (probability - example.label) * classWeight;
      biasGradient += error;
      for (let index = 0; index < gradients.length; index++) {
        gradients[index] += error * features[index];
      }
    }
    const rate = 0.12 / examples.length;
    bias -= rate * biasGradient;
    for (let index = 0; index < weights.length; index++) {
      weights[index] -= rate * (gradients[index] + 0.8 * weights[index]);
    }
  }

  const confidence = Math.max(0, Math.min(1, (examples.length - minimumRows) / (FULL_INFLUENCE_ROWS - minimumRows)));
  return {
    active: true,
    sampleCount: examples.length,
    acceptedCount: accepted,
    declinedCount: declined,
    confidence,
    weights: Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, weights[index]])),
    predict(features) {
      return sigmoid(
        bias + FEATURE_NAMES.reduce(
          (sum, name, index) => sum + (Number(features?.[name]) || 0) * weights[index],
          0
        )
      );
    },
  };
}

export function trainAcceptanceModel(examples) {
  return trainBinaryModel(examples);
}

/** Learns a separate relevance signal from members' explicit match ratings. */
export function trainRelevanceModel(feedbackRows) {
  const examples = feedbackRows
    .filter((row) => row.modelFeatures && (row.rating >= 4 || row.rating <= 2))
    .map((row) => ({ features: row.modelFeatures, label: row.rating >= 4 ? 1 : 0 }));
  const model = trainBinaryModel(examples, { minimumRows: 8, minimumPerClass: 3 });
  return { ...model, sampleCount: examples.length };
}

/** Time-ordered holdout metrics; the newest examples are never used to fit. */
export function evaluateTemporalModel(rows, { holdoutFraction = 0.2 } = {}) {
  const eligible = rows
    .filter((row) => row.modelFeatures && ["ACCEPTED", "DECLINED"].includes(row.status))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const holdoutSize = Math.max(1, Math.ceil(eligible.length * holdoutFraction));
  const splitAt = eligible.length - holdoutSize;
  const training = eligible.slice(0, splitAt).map((row) => ({
    features: row.modelFeatures,
    label: row.status === "ACCEPTED" ? 1 : 0,
  }));
  const holdout = eligible.slice(splitAt);
  const model = trainAcceptanceModel(training);
  if (!model.active || holdout.length < 2 || new Set(holdout.map((row) => row.status)).size < 2) {
    return {
      available: false,
      reason: "More historical outcomes from both classes are needed for a time-separated evaluation.",
      trainingExamples: training.length,
      holdoutExamples: holdout.length,
    };
  }

  const scored = holdout.map((row) => ({
    label: row.status === "ACCEPTED" ? 1 : 0,
    probability: model.predict(row.modelFeatures),
  }));
  const brierScore = scored.reduce((sum, row) => sum + (row.probability - row.label) ** 2, 0) / scored.length;
  let concordant = 0;
  let positiveNegativePairs = 0;
  for (const positive of scored.filter((row) => row.label === 1)) {
    for (const negative of scored.filter((row) => row.label === 0)) {
      positiveNegativePairs++;
      concordant += positive.probability > negative.probability ? 1 : positive.probability === negative.probability ? 0.5 : 0;
    }
  }
  return {
    available: true,
    trainingExamples: training.length,
    holdoutExamples: holdout.length,
    acceptedHoldout: scored.filter((row) => row.label === 1).length,
    declinedHoldout: scored.filter((row) => row.label === 0).length,
    brierScore: +brierScore.toFixed(4),
    rocAuc: positiveNegativePairs ? +(concordant / positiveNegativePairs).toFixed(4) : null,
    note: "Newest 20% of resolved requests held out by time; this is an internal diagnostic, not an independent user study.",
  };
}

export function evaluateTemporalRelevance(feedbackRows, { holdoutFraction = 0.2 } = {}) {
  const eligible = feedbackRows
    .filter((row) => row.modelFeatures && (row.rating >= 4 || row.rating <= 2))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const holdoutSize = Math.max(1, Math.ceil(eligible.length * holdoutFraction));
  const splitAt = eligible.length - holdoutSize;
  const training = eligible.slice(0, splitAt);
  const holdout = eligible.slice(splitAt);
  const model = trainRelevanceModel(training);
  if (!model.active || holdout.length < 2 || new Set(holdout.map((row) => row.rating >= 4)).size < 2) {
    return {
      available: false,
      reason: "More dated useful and not-useful ratings are needed for a time-separated relevance evaluation.",
      trainingExamples: model.sampleCount,
      holdoutExamples: holdout.length,
    };
  }

  const scored = holdout.map((row) => ({
    label: row.rating >= 4 ? 1 : 0,
    probability: model.predict(row.modelFeatures),
  }));
  const brierScore = scored.reduce((sum, row) => sum + (row.probability - row.label) ** 2, 0) / scored.length;
  let concordant = 0;
  let positiveNegativePairs = 0;
  for (const positive of scored.filter((row) => row.label === 1)) {
    for (const negative of scored.filter((row) => row.label === 0)) {
      positiveNegativePairs++;
      concordant += positive.probability > negative.probability ? 1 : positive.probability === negative.probability ? 0.5 : 0;
    }
  }
  return {
    available: true,
    trainingExamples: training.length,
    holdoutExamples: holdout.length,
    usefulHoldout: scored.filter((row) => row.label === 1).length,
    notUsefulHoldout: scored.filter((row) => row.label === 0).length,
    brierScore: +brierScore.toFixed(4),
    rocAuc: positiveNegativePairs ? +(concordant / positiveNegativePairs).toFixed(4) : null,
    note: "Newest 20% of member match ratings held out by time; this is an internal diagnostic, not an independent user study.",
  };
}

export function buildTrainingExamples(requests) {
  return requests
    .filter((request) => request.modelFeatures && ["ACCEPTED", "DECLINED"].includes(request.status))
    .map((request) => ({
      features: request.modelFeatures,
      label: request.status === "ACCEPTED" ? 1 : 0,
    }));
}

export function scoreCandidate({
  owner,
  candidate,
  ownerAttrs,
  candidateAttrs,
  connectionsByUser,
  collaborativeScoreOverride,
  model,
  totalAcceptedInteractions = 0,
}) {
  const contentScore = computeContentScore(ownerAttrs, candidateAttrs);
  const collaborativeScore = Number.isFinite(collaborativeScoreOverride)
    ? collaborativeScoreOverride
    : computeCollaborativeScore(connectionsByUser, owner.userId, candidate.user.id);
  const baselineWeights = computeHybridWeights(totalAcceptedInteractions);
  const semanticScore = profileSemanticSimilarity(owner, candidate);
  const modelFeatures = extractPairFeatures(owner, candidate, "MENTORSHIP", collaborativeScore);
  const topicsDeclared = [...(owner.mentorshipTopics || []), ...(candidate.mentorshipTopics || [])]
    .some((topic) => topic.direction === "SEEKING");
  const topicWeight = topicsDeclared ? 0.18 : 0;
  const profileScore = contentScore * (0.78 - topicWeight * 0.78) +
    semanticScore * (0.22 - topicWeight * 0.22) +
    modelFeatures.mentorshipTopicFit * topicWeight;
  const baselineScore = computeHybridScore(profileScore, collaborativeScore, baselineWeights);
  const mlAcceptanceProbability = model.active ? model.predict(modelFeatures) : null;
  // Acceptance is a request-response prediction, not a measure of whether
  // two profiles are a useful match. Keep it descriptive and out of ranking.
  const matchScore = baselineScore;

  return {
    contentScore,
    semanticScore,
    collaborativeScore,
    baselineScore,
    modelFeatures,
    mlAcceptanceProbability,
    matchScore,
    mlConfidence: model.confidence,
  };
}
