function localPredictionResult(candidates, localModel, relevanceModel, provider) {
  return {
    provider,
    model: {
      active: localModel.active,
      sampleCount: localModel.sampleCount,
      acceptedCount: localModel.acceptedCount,
      declinedCount: localModel.declinedCount,
      confidence: localModel.confidence,
      weights: localModel.weights || null,
    },
    predictions: candidates.map(({ features }) =>
      localModel.active ? localModel.predict(features) : null
    ),
    relevanceModel: {
      active: relevanceModel.active,
      sampleCount: relevanceModel.sampleCount,
      acceptedCount: relevanceModel.acceptedCount,
      declinedCount: relevanceModel.declinedCount,
      confidence: relevanceModel.confidence,
      weights: relevanceModel.weights || null,
    },
    relevancePredictions: candidates.map(({ features }) =>
      relevanceModel.active ? relevanceModel.predict(features) : null
    ),
    ncfModel: { active: false, sampleCount: 0, acceptedCount: 0, declinedCount: 0, confidence: 0 },
    ncfPredictions: candidates.map(() => null),
  };
}

/** Send numeric-only training examples and candidate features to the HF Space. */
export async function getAdaptivePredictions({ examples, relevanceExamples = [], candidates, ncfCandidates = [], localModel, relevanceModel, artifacts = [] }) {
  const acceptanceArtifact = artifacts.find((artifact) => artifact.type === "ACCEPTANCE" && artifact.active);
  const relevanceArtifact = artifacts.find((artifact) => artifact.type === "RELEVANCE" && artifact.active);
  const ncfArtifact = artifacts.find((artifact) => artifact.type === "NCF" && artifact.active);
  if (acceptanceArtifact || relevanceArtifact || ncfArtifact) {
    const sigmoid = (value) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
    const predictArtifact = (artifact, features) => {
      if (!artifact) return null;
      const weights = artifact.weights && typeof artifact.weights === "object" ? artifact.weights : {};
      const logit = Number(artifact.bias || 0) + (Array.isArray(artifact.featureNames) ? artifact.featureNames : []).reduce(
        (sum, name) => sum + (Number(features?.[name]) || 0) * (Number(weights[name]) || 0), 0
      );
      return sigmoid(logit);
    };
    const predictNcf = (candidate, isMentorship) => {
      const payload = ncfArtifact?.weights;
      const sender = payload?.userEmbeddings?.[candidate?.senderKey];
      const recipient = payload?.userEmbeddings?.[candidate?.recipientKey];
      if (!sender || !recipient) return null;
      const baseInput = [...sender, ...recipient, isMentorship ? 1 : 0, isMentorship ? 0 : 1];
      const inputWidth = payload.layer1.weights?.[0]?.length || baseInput.length;
      const availabilityInput = [
        "availabilityDayOverlap",
        "availabilityTimeOverlap",
        "availabilityFrequencyFit",
        "availabilityPairKnown",
      ].map((name) => Number(candidate?.features?.[name]) || 0);
      // Older Colab artifacts have 18 inputs. They remain usable until the
      // availability-aware NCF artifact is retrained and published.
      const input = inputWidth > baseInput.length
        ? [...baseInput, ...availabilityInput].slice(0, inputWidth)
        : baseInput;
      const hidden = payload.layer1.weights.map((weights, index) => Math.max(0,
        weights.reduce((sum, weight, featureIndex) => sum + weight * input[featureIndex], payload.layer1.bias[index])
      ));
      const output = payload.layer2.weights[0].reduce((sum, weight, index) => sum + weight * hidden[index], payload.layer2.bias[0]);
      return sigmoid(output);
    };
    const describe = (artifact, fallback) => artifact ? {
      active: true,
      sampleCount: artifact.sampleCount,
      acceptedCount: artifact.positiveCount,
      declinedCount: artifact.negativeCount,
      confidence: artifact.confidence,
      weights: artifact.weights,
      version: artifact.version,
      createdAt: artifact.createdAt,
      metrics: artifact.metrics,
    } : {
      active: fallback.active,
      sampleCount: fallback.sampleCount,
      acceptedCount: fallback.acceptedCount,
      declinedCount: fallback.declinedCount,
      confidence: fallback.confidence,
      weights: fallback.weights || null,
    };
    return {
      provider: "COLAB_DRIVE_ARTIFACT",
      model: describe(acceptanceArtifact, localModel),
      predictions: candidates.map(({ features }) => acceptanceArtifact
        ? predictArtifact(acceptanceArtifact, features)
        : (localModel.active ? localModel.predict(features) : null)),
      relevanceModel: describe(relevanceArtifact, relevanceModel),
      relevancePredictions: candidates.map(({ features }) => relevanceArtifact
        ? predictArtifact(relevanceArtifact, features)
        : (relevanceModel.active ? relevanceModel.predict(features) : null)),
      ncfModel: ncfArtifact ? {
        active: true,
        sampleCount: ncfArtifact.sampleCount,
        acceptedCount: ncfArtifact.positiveCount,
        declinedCount: ncfArtifact.negativeCount,
        confidence: ncfArtifact.confidence,
        version: ncfArtifact.version,
        createdAt: ncfArtifact.createdAt,
        metrics: ncfArtifact.metrics,
      } : { active: false, sampleCount: 0, acceptedCount: 0, declinedCount: 0, confidence: 0 },
      ncfPredictions: candidates.map((_, index) => {
        const candidate = ncfCandidates[index];
        if (!candidate) return null;
        const connection = predictNcf(candidate, false);
        const mentorship = predictNcf(candidate, true);
        if (connection === null && mentorship === null) return null;
        if (connection === null) return mentorship;
        if (mentorship === null) return connection;
        return (connection + mentorship) / 2;
      }),
    };
  }

  const serviceUrl = (
    process.env.ML_SERVICE_URL || process.env.HF_ML_SERVICE_URL
  )?.replace(/\/$/, "");
  const serviceToken = process.env.ML_SERVICE_TOKEN || process.env.HF_ML_SERVICE_TOKEN;

  if (!serviceUrl || !serviceToken) {
    return localPredictionResult(
      candidates,
      localModel,
      relevanceModel,
      serviceUrl ? "LOCAL (HOSTED SERVICE TOKEN MISSING)" : "LOCAL"
    );
  }

  try {
    const response = await fetch(`${serviceUrl}/predict`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        training_examples: examples,
        relevance_examples: relevanceExamples,
        candidates,
      }),
      cache: "no-store",
      // Fall back to the local model quickly when the optional hosted service
      // is cold or unreachable; recommendation pages should not wait 10s.
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      throw new Error(`Hosted recommender returned ${response.status}`);
    }

    const result = await response.json();
    if (
      !Array.isArray(result.predictions) ||
      result.predictions.length !== candidates.length
    ) {
      throw new Error("Hosted recommender returned an invalid prediction list");
    }

    return {
      provider: "HOSTED_API",
      model: {
        active: Boolean(result.active),
        sampleCount: Number(result.trainingExamples) || 0,
        acceptedCount: Number(result.acceptedExamples) || 0,
        declinedCount: Number(result.declinedExamples) || 0,
        confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
        weights: result.featureWeights || null,
      },
      predictions: result.predictions.map((value) =>
        value == null ? null : Math.max(0, Math.min(1, Number(value)))
      ),
      relevanceModel: result.relevanceModel ? {
        active: Boolean(result.relevanceModel.active),
        sampleCount: Number(result.relevanceModel.trainingExamples) || 0,
        acceptedCount: Number(result.relevanceModel.acceptedExamples) || 0,
        declinedCount: Number(result.relevanceModel.declinedExamples) || 0,
        confidence: Math.max(0, Math.min(1, Number(result.relevanceModel.confidence) || 0)),
        weights: result.relevanceModel.featureWeights || null,
      } : {
        active: relevanceModel.active,
        sampleCount: relevanceModel.sampleCount,
        acceptedCount: relevanceModel.acceptedCount,
        declinedCount: relevanceModel.declinedCount,
        confidence: relevanceModel.confidence,
        weights: relevanceModel.weights || null,
      },
      relevancePredictions: Array.isArray(result.relevancePredictions) && result.relevancePredictions.length === candidates.length
        ? result.relevancePredictions.map((value) => value == null ? null : Math.max(0, Math.min(1, Number(value))))
        : candidates.map(({ features }) => relevanceModel.active ? relevanceModel.predict(features) : null),
      ncfModel: { active: false, sampleCount: 0, acceptedCount: 0, declinedCount: 0, confidence: 0 },
      ncfPredictions: candidates.map(() => null),
    };
  } catch (error) {
    console.warn("Hosted recommender unavailable; using the local model:", error.message);
    return localPredictionResult(candidates, localModel, relevanceModel, "LOCAL_FALLBACK");
  }
}
