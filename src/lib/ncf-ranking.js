// A quality-approved NCF artifact contributes a small, visible share of the
// ordering score when it can produce a prediction for both members.
export const NCF_RANKING_INFLUENCE = 0.1;

export function withNcfRankingSignal(item, probability) {
  const available = typeof probability === "number" && Number.isFinite(probability);
  const influence = available ? NCF_RANKING_INFLUENCE : 0;
  return {
    ...item,
    ncfProbability: available ? probability : null,
    ncfInfluence: influence,
    rankingScore: item.matchScore * (1 - influence) + (available ? probability * influence : 0),
  };
}
