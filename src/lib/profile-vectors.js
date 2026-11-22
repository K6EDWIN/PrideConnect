// Small, transparent profile text vectors for the aviation vocabulary in this
// app. Tokens are normalized into domain concepts, then represented by a
// sparse bag-of-words/bigrams vector. This runs locally and sends no profile
// text to the hosted ML service.
const STOP_WORDS = new Set(["and", "the", "for", "with", "from", "your", "you", "our", "are", "has", "have", "was", "were", "into", "across", "about", "this", "that"]);
const DOMAIN_SYNONYMS = [
  ["flight operations", "flight ops", "air operations", "flight dispatch", "flight planning"],
  ["ground operations", "ground ops", "airport operations", "ramp operations", "ground handling"],
  ["cabin crew", "cabin services", "flight attendant", "inflight services"],
  ["customer experience", "customer service", "passenger experience", "guest experience"],
  ["safety management", "aviation safety", "safety assurance", "safety compliance"],
  ["engineering", "aircraft maintenance", "aircraft engineering", "maintenance engineering"],
  ["data analytics", "data analysis", "business intelligence", "data science"],
  ["leadership", "people management", "team leadership", "executive leadership"],
  ["project management", "program management", "project delivery"],
  ["mentorship", "coaching", "career guidance", "professional development"],
  ["revenue management", "yield management", "airline revenue"],
  ["network planning", "route planning", "airline network strategy"],
];

function normalizeText(value) {
  let text = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const [canonical, ...aliases] of DOMAIN_SYNONYMS) {
    for (const alias of [canonical, ...aliases]) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(`\\b${escaped}\\b`, "g"), canonical.replaceAll(" ", "_"));
    }
  }
  return text;
}

export function profileVector(profile) {
  const vector = new Map();
  const fields = [
    [profile?.department, 0.7],
    [profile?.bio, 1],
    [profile?.professionalBackground, 1.4],
    [profile?.trainingHistory, 1.4],
    [profile?.careerGoals, 2],
    [profile?.mentorshipNeeds, 2.5],
    ...((profile?.skills || []).map((item) => [item.skill?.name || item.name, 1.5])),
    ...((profile?.interests || []).map((item) => [item.interest?.name || item.name, 0.8])),
    ...((profile?.mentorshipTopics || []).map((item) => [item.skill?.name || item.name, 2.5])),
  ];
  for (const [value, weight] of fields) {
    const terms = normalizeText(value).split(/\s+/).filter((token) => token.length > 2 && !STOP_WORDS.has(token));
    const features = [...terms];
    for (let index = 0; index < terms.length - 1; index++) features.push(`${terms[index]}_${terms[index + 1]}`);
    for (const feature of features) {
      vector.set(feature, (vector.get(feature) || 0) + weight);
    }
  }
  return vector;
}

export function profileSemanticSimilarity(profileA, profileB) {
  const vectorA = profileVector(profileA);
  const vectorB = profileVector(profileB);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, value] of vectorA) {
    dot += value * (vectorB.get(term) || 0);
    normA += value * value;
  }
  for (const value of vectorB.values()) normB += value * value;
  if (!normA || !normB) return 0;
  const cosine = dot / Math.sqrt(normA * normB);
  return Math.max(0, Math.min(1, cosine));
}

export function explainProfileMatch(owner, candidate, features = {}) {
  const reasons = [];
  const ownerSkills = new Set((owner.skills || []).map((row) => row.skillId));
  const sharedSkills = (candidate.skills || [])
    .filter((row) => ownerSkills.has(row.skillId))
    .map((row) => row.skill?.name || row.name)
    .filter(Boolean)
    .slice(0, 3);
  if (sharedSkills.length) reasons.push(`Shared skills: ${sharedSkills.join(", ")}`);

  const idName = new Map();
  for (const topic of [...(owner.mentorshipTopics || []), ...(candidate.mentorshipTopics || [])]) {
    if (topic.skillId && topic.skill?.name) idName.set(topic.skillId, topic.skill.name);
  }
  const seeking = new Set((owner.mentorshipTopics || []).filter((topic) => topic.direction === "SEEKING").map((topic) => topic.skillId));
  const candidateOffers = new Set((candidate.mentorshipTopics || []).filter((topic) => topic.direction === "OFFERING").map((topic) => topic.skillId));
  const teaching = [...seeking].filter((id) => candidateOffers.has(id)).map((id) => idName.get(id)).filter(Boolean);
  if (teaching.length) reasons.push(`They can help with: ${teaching.slice(0, 2).join(", ")}`);

  const ownerOffers = new Set((owner.mentorshipTopics || []).filter((topic) => topic.direction === "OFFERING").map((topic) => topic.skillId));
  const candidateSeeks = new Set((candidate.mentorshipTopics || []).filter((topic) => topic.direction === "SEEKING").map((topic) => topic.skillId));
  const reciprocal = [...candidateSeeks].filter((id) => ownerOffers.has(id)).map((id) => idName.get(id)).filter(Boolean);
  if (reciprocal.length) reasons.push(`You can support their goals in: ${reciprocal.slice(0, 2).join(", ")}`);

  if (features.mentorshipRoleFit) reasons.push("Mentor and mentee roles are compatible");
  if (features.availabilityPairKnown && (features.availabilityDayOverlap > 0 || features.availabilityTimeOverlap > 0)) reasons.push("Your availability has an overlap");
  if (features.semanticProfileOverlap >= 0.25) reasons.push("Career goals and professional backgrounds are aligned");
  if (!reasons.length) reasons.push("Roles and stated availability do not conflict");
  return reasons.slice(0, 4);
}

export function diversifyRankedCandidates(candidates, limit = 12) {
  const remaining = [...candidates];
  const selected = [];
  const departmentCounts = new Map();
  const roleCounts = new Map();

  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestAdjusted = -Infinity;
    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index];
      const department = candidate.candidate?.department || candidate.department || "Unassigned";
      const role = candidate.candidate?.user?.role || candidate.role || "UNKNOWN";
      const adjustment = Math.min(0.12, (departmentCounts.get(department) || 0) * 0.055) +
        Math.min(0.08, (roleCounts.get(role) || 0) * 0.025);
      const adjusted = (candidate.rankingScore ?? candidate.matchScore) - adjustment;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIndex = index;
      }
    }

    const [candidate] = remaining.splice(bestIndex, 1);
    const department = candidate.candidate?.department || candidate.department || "Unassigned";
    const role = candidate.candidate?.user?.role || candidate.role || "UNKNOWN";
    const adjustment = Math.max(0, (candidate.rankingScore ?? candidate.matchScore) - bestAdjusted);
    selected.push({ ...candidate, diversityAdjustment: adjustment });
    departmentCounts.set(department, (departmentCounts.get(department) || 0) + 1);
    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
  }

  return selected;
}
