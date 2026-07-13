export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `${response.status} ${response.statusText}`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function formatUtc(value?: string | Date): string {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

export function frequency(value?: number): string {
  return value ? `${(value / 1_000_000).toFixed(3)} MHz` : '—'
}

