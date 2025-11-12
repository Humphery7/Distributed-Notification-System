export function createResponse({ success = true, data = null, error = null, message = "", meta = {} } = {}) {
    const defaultMeta = { total: 0, limit: 0, page: 0, total_pages: 0, has_next: false, has_previous: false };
    return {
      success,
      data: data ?? undefined,
      error: error ?? undefined,
      message,
      meta: Object.assign(defaultMeta, meta || {})
    };
  }
  