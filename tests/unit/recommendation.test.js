import { describe, it, expect } from "vitest";
import {
  jaccard,
  computeContentScore,
  sharedAttributes,
} from "@/lib/recommendation";
import { scoreCandidate } from "@/lib/adaptive-recommender";

describe("Content-Based Filtering (recommendation.js)", () => {
  it("keeps acceptance likelihood separate from the profile ranking score", () => {
    const result = scoreCandidate({
      owner: { userId: "owner", mentorshipRole: "MENTOR", mentorshipTopics: [] },
      candidate: {
        user: { id: "candidate" }, mentorshipRole: "MENTEE", mentorshipTopics: [],
        department: "Flight Operations", skills: [], interests: [],
      },
      ownerAttrs: { skillIds: ["flight-ops"], interestIds: [] },
      candidateAttrs: { skillIds: ["flight-ops"], interestIds: [] },
      connectionsByUser: new Map(),
      model: { active: true, confidence: 1, predict: () => 0.99 },
      totalAcceptedInteractions: 0,
    });

    expect(result.mlAcceptanceProbability).toBe(0.99);
    expect(result.matchScore).toBe(result.baselineScore);
    expect(result.matchScore).not.toBe(result.mlAcceptanceProbability);
  });

  describe("jaccard()", () => {
    it("returns 0 when both sets are empty", () => {
      const setA = new Set();
      const setB = new Set();
      expect(jaccard(setA, setB)).toBe(0);
    });

    it("returns 0 when sets are disjoint", () => {
      const setA = new Set(["skill-1", "skill-2"]);
      const setB = new Set(["skill-3", "skill-4"]);
      expect(jaccard(setA, setB)).toBe(0);
    });

    it("returns 1 when sets are identical", () => {
      const setA = new Set(["pilot", "safety"]);
      const setB = new Set(["pilot", "safety"]);
      expect(jaccard(setA, setB)).toBe(1);
    });

    it("computes correct Jaccard similarity for partial overlap", () => {
      // Intersection: {b, c} (size 2), Union: {a, b, c, d} (size 4) => 2/4 = 0.5
      const setA = new Set(["a", "b", "c"]);
      const setB = new Set(["b", "c", "d"]);
      expect(jaccard(setA, setB)).toBe(0.5);
    });
  });

  describe("computeContentScore()", () => {
    it("returns 1.0 when both skills and interests are identical", () => {
      const profileA = {
        skillIds: ["skill-flight-ops", "skill-navigation"],
        interestIds: ["interest-leadership", "interest-safety"],
      };
      const profileB = {
        skillIds: ["skill-flight-ops", "skill-navigation"],
        interestIds: ["interest-leadership", "interest-safety"],
      };

      const score = computeContentScore(profileA, profileB);
      expect(score).toBeCloseTo(1.0);
    });

    it("returns 0.0 when there is no skill or interest overlap", () => {
      const profileA = {
        skillIds: ["skill-a"],
        interestIds: ["interest-a"],
      };
      const profileB = {
        skillIds: ["skill-b"],
        interestIds: ["interest-b"],
      };

      const score = computeContentScore(profileA, profileB);
      expect(score).toBe(0.0);
    });

    it("correctly weights skills (0.6) and interests (0.4)", () => {
      // Perfect skill match (1.0), zero interest match (0.0) => 0.6 * 1.0 + 0.4 * 0 = 0.6
      const skillsOnlyMatch = computeContentScore(
        { skillIds: ["pilot"], interestIds: ["music"] },
        { skillIds: ["pilot"], interestIds: ["art"] }
      );
      expect(skillsOnlyMatch).toBeCloseTo(0.6);

      // Zero skill match (0.0), perfect interest match (1.0) => 0.6 * 0 + 0.4 * 1.0 = 0.4
      const interestsOnlyMatch = computeContentScore(
        { skillIds: ["engineer"], interestIds: ["mentoring"] },
        { skillIds: ["pilot"], interestIds: ["mentoring"] }
      );
      expect(interestsOnlyMatch).toBeCloseTo(0.4);
    });

    it("handles empty attribute arrays without throwing", () => {
      const profileA = { skillIds: [], interestIds: [] };
      const profileB = { skillIds: ["skill-1"], interestIds: ["interest-1"] };

      expect(computeContentScore(profileA, profileB)).toBe(0);
    });
  });

  describe("sharedAttributes()", () => {
    it("extracts matching skills and interests between two profiles", () => {
      const profileA = {
        skillIds: ["s1", "s2", "s3"],
        interestIds: ["i1", "i2"],
      };
      const profileB = {
        skillIds: ["s2", "s3", "s4"],
        interestIds: ["i2", "i3"],
      };

      const shared = sharedAttributes(profileA, profileB);
      expect(shared.sharedSkillIds).toEqual(["s2", "s3"]);
      expect(shared.sharedInterestIds).toEqual(["i2"]);
    });

    it("returns empty arrays when profiles share no attributes", () => {
      const profileA = { skillIds: ["s1"], interestIds: ["i1"] };
      const profileB = { skillIds: ["s2"], interestIds: ["i2"] };

      const shared = sharedAttributes(profileA, profileB);
      expect(shared.sharedSkillIds).toEqual([]);
      expect(shared.sharedInterestIds).toEqual([]);
    });
  });
});
