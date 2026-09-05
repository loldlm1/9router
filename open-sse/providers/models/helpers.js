// Codex auto-generates a "-review" variant for each llm model (review quota family)
export const CODEX_REVIEW_SUFFIX = "-review";
export const CODEX_PRO_SUFFIX = "-pro";

const CODEX_METADATA_FIELDS = [
  "kind",
  "type",
  "upstreamModelId",
  "quotaFamily",
  "reasoningEfforts",
  "reasoningModes",
  "reasoningMode",
  "supportedFormats",
  "targetFormat",
  "strip",
];

function codexModelId(model) {
  return model?.id || model?.slug || model?.model || model?.name || null;
}

function isCodexChatModel(model, id) {
  const kind = model?.kind || model?.type || "llm";
  return !["image", "embedding", "tts", "stt", "audio"].includes(kind)
    && !id.toLowerCase().includes("embed");
}

function mergeStaticMetadata(model, staticModel) {
  if (!staticModel) return model;
  const merged = { ...model };
  for (const field of CODEX_METADATA_FIELDS) {
    if (staticModel[field] !== undefined) merged[field] = staticModel[field];
  }
  return merged;
}

/**
 * Merge account-visible Codex catalog rows with local routing metadata and add
 * only the virtual routes supported by each visible base model.
 */
export function mergeCodexCatalogModels(liveModels, staticModels = []) {
  const staticById = new Map(staticModels.map((model) => [model.id, model]));
  const modelsById = new Map();
  const visibleBaseIds = new Set();

  for (const rawModel of liveModels || []) {
    const id = codexModelId(rawModel);
    if (!id) continue;
    const staticModel = staticById.get(id);
    const name = rawModel?.display_name || rawModel?.displayName || rawModel?.name || staticModel?.name || id;
    const normalized = mergeStaticMetadata({ ...rawModel, id, name }, staticModel);
    modelsById.set(id, { ...(modelsById.get(id) || {}), ...normalized });

    if (isCodexChatModel(normalized, id)) {
      visibleBaseIds.add(staticModel?.upstreamModelId || normalized.upstreamModelId || id);
    }
  }

  for (const baseId of visibleBaseIds) {
    const staticBase = staticById.get(baseId);
    const existingBase = modelsById.get(baseId);
    if (!existingBase && !staticBase) continue;

    const base = mergeStaticMetadata(
      existingBase || { id: baseId, name: staticBase?.name || baseId },
      staticBase,
    );
    modelsById.set(baseId, base);

    const proId = `${baseId}${CODEX_PRO_SUFFIX}`;
    const staticPro = staticById.get(proId);
    if (staticPro || base.reasoningModes?.includes("pro")) {
      const generatedPro = mergeStaticMetadata({
        ...base,
        id: proId,
        name: staticPro?.name || `${base.name} Pro`,
        upstreamModelId: base.upstreamModelId || baseId,
        reasoningMode: "pro",
      }, staticPro);
      modelsById.set(proId, mergeStaticMetadata(modelsById.get(proId) || generatedPro, staticPro));
    }

    const reviewId = `${baseId}${CODEX_REVIEW_SUFFIX}`;
    const staticReview = staticById.get(reviewId);
    const generatedReview = mergeStaticMetadata({
      ...base,
      id: reviewId,
      name: staticReview?.name || `${base.name} Review`,
      upstreamModelId: base.upstreamModelId || baseId,
      quotaFamily: "review",
    }, staticReview);
    modelsById.set(reviewId, mergeStaticMetadata(modelsById.get(reviewId) || generatedReview, staticReview));
  }

  return Array.from(modelsById.values());
}

export function withCodexReviewModels(models) {
  return models.flatMap((model) => {
    if ((model.kind || model.type || "llm") !== "llm" || model.id.endsWith(CODEX_REVIEW_SUFFIX)) {
      return [model];
    }
    return [
      model,
      {
        ...model,
        id: `${model.id}${CODEX_REVIEW_SUFFIX}`,
        name: `${model.name} Review`,
        upstreamModelId: model.upstreamModelId || model.id,
        quotaFamily: "review"
      }
    ];
  });
}

export function isMuseSparkModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const clean = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  const base = clean.includes("/") ? clean.split("/").pop() : clean;
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base);
}
