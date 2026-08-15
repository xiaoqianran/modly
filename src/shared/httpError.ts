/** FastAPI / axios errors the UI can show. Prefer `detail` over AxiosError.toString(). */

export function httpErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const data = (err as { response?: { data?: { detail?: unknown } } }).response?.data
    const detail = data?.detail
    if (typeof detail === 'string' && detail.trim()) return detail
    if (Array.isArray(detail) && detail.length > 0) {
      const parts = detail
        .map((item) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object' && 'msg' in item) {
            return String((item as { msg: unknown }).msg)
          }
          return ''
        })
        .filter(Boolean)
      if (parts.length > 0) return parts.join('; ')
    }
  }
  if (err instanceof Error && err.message) return err.message
  return String(err)
}
