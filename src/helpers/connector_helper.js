import axios from "axios"

const API_URL = process.env.REACT_APP_MCP_CONNECTOR_URL || "http://localhost:3002"
const CHART_URL = process.env.REACT_APP_CHART_SERVER_URL || "http://localhost:3000"

const connectorApi = axios.create({
  baseURL: API_URL,
  headers: { "content-type": "application/json" },
})

// Add JWT token to all requests
connectorApi.interceptors.request.use(config => {
  const token = localStorage.getItem("jwt_token")
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Handle token expiration
connectorApi.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 403 || error.response?.status === 401) {
      localStorage.removeItem("jwt_token")
      window.location.href = "/login"
    }
    return Promise.reject(error)
  }
)

// Watchlist and symbols
export async function getWatchlist() {
  const response = await connectorApi.get("/api/watchlist")
  return response.data
}

// Signals and verdicts
export async function getSignals({ limit = 50, symbol = null, latest = false } = {}) {
  let path = "/api/signals"
  const params = []
  if (limit) params.push(`limit=${limit}`)
  if (latest) params.push("latest=true")
  if (symbol) params.push(`symbol=${encodeURIComponent(symbol)}`)
  if (params.length) path += "?" + params.join("&")

  const response = await connectorApi.get(path)
  return response.data
}

export async function getSymbolSignals(symbol) {
  const response = await connectorApi.get(`/api/signals/${encodeURIComponent(symbol)}`)
  return response.data
}

// Runs
export async function runSymbol(symbol) {
  const response = await connectorApi.post("/api/runs", { symbol })
  return response.data
}

// Agents — the full roster including disabled ones, with prompts.
export async function getAgents() {
  const response = await connectorApi.get("/api/agents")
  return response.data
}

/** Patch one agent; omitted fields keep their current value. */
export async function updateAgent(id, changes) {
  const response = await connectorApi.patch(
    `/api/agents/${encodeURIComponent(id)}`,
    changes
  )
  return response.data
}

// Workflow DAG
export async function getWorkflow() {
  const response = await connectorApi.get("/api/workflow")
  return response.data
}

/**
 * Build a run without executing it: agent prompts carrying the ICT facts for
 * this symbol, plus base64 chart images for the vision agents. Rendering the
 * four timeframes takes a while, hence the extended timeout.
 */
export async function prepareRun(symbol) {
  const response = await connectorApi.post(
    "/api/prepare",
    { symbol },
    { timeout: 180000 }
  )
  return response.data
}

/** Run one agent. Passing images routes it to the vision model. */
export async function executeAgent(agent, userInput, cancelToken) {
  const response = await connectorApi.post(
    "/api/execute",
    {
      systemPrompt: agent.systemPrompt,
      userInput,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      images: agent.images || [],
    },
    { timeout: 180000, cancelToken }
  )
  return response.data
}

// axios 0.21 predates AbortController support, so a run is stopped through a
// CancelToken instead.
export function createCancelSource() {
  return axios.CancelToken.source()
}

export function isCancel(err) {
  return axios.isCancel(err)
}

// Scheduler
export async function getScheduler() {
  const response = await connectorApi.get("/api/scheduler")
  return response.data
}

export async function schedulerAction(action) {
  const response = await connectorApi.post(`/api/scheduler/${action}`)
  return response.data
}

// Settings and alerts
export async function getSettings() {
  const response = await connectorApi.get("/api/settings")
  return response.data
}

export async function saveSettings(data) {
  const response = await connectorApi.post("/api/settings", data)
  return response.data
}

export async function testTelegram() {
  const response = await connectorApi.post("/api/settings/telegram/test")
  return response.data
}

// Health and status
export async function getHealth() {
  const response = await connectorApi.get("/api/health")
  return response.data
}

// Chart snapshot URL helper
export function chartUrl(path) {
  if (!path) return null
  const filename = path.replace(/^\/snapshots\//, "")
  return `${CHART_URL}/snapshots/${filename}`
}
