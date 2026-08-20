function paginationFrom(query, defaults = {}) {
  const defaultLimit = defaults.defaultLimit || 50;
  const maxLimit = defaults.maxLimit || 100;
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

function paginationMeta(total, page, limit) {
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

module.exports = { paginationFrom, paginationMeta };
