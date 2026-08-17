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

// Symbol check (pass/fail only)
export async function checkSymbol(symbol) {
  const response = await connectorApi.post("/api/symbols/check", { symbol })
  return response.data
}

// Agents (user-authored LLM steps)
export async function listAgents() {
  const response = await connectorApi.get("/api/agents")
  return response.data
}

export async function createAgent(agent) {
  const response = await connectorApi.post("/api/agents", agent)
  return response.data
}

export async function updateAgent(id, agent) {
  const response = await connectorApi.put(`/api/agents/${encodeURIComponent(id)}`, agent)
  return response.data
}

export async function deleteAgent(id) {
  const response = await connectorApi.delete(`/api/agents/${encodeURIComponent(id)}`)
  return response.data
}

// Workflows (ordered agent chains + cron)
export async function listWorkflows() {
  const response = await connectorApi.get("/api/workflows")
  return response.data
}

export async function createWorkflow(workflow) {
  const response = await connectorApi.post("/api/workflows", workflow)
  return response.data
}

export async function updateWorkflow(id, workflow) {
  const response = await connectorApi.put(`/api/workflows/${encodeURIComponent(id)}`, workflow)
  return response.data
}

export async function deleteWorkflow(id) {
  const response = await connectorApi.delete(`/api/workflows/${encodeURIComponent(id)}`)
  return response.data
}

/** Fire-and-forget: poll signals for the result. */
export async function runWorkflow(id) {
  const response = await connectorApi.post(`/api/workflows/${encodeURIComponent(id)}/run`)
  return response.data
}

export async function startWorkflowSchedule(id) {
  const response = await connectorApi.post(`/api/workflows/${encodeURIComponent(id)}/schedule/start`)
  return response.data
}

export async function stopWorkflowSchedule(id) {
  const response = await connectorApi.post(`/api/workflows/${encodeURIComponent(id)}/schedule/stop`)
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

/** Thorough check — exercises DB, chart server, Telegram, and every MCP. */
export async function getFullHealth() {
  const response = await connectorApi.get("/api/health/full")
  return response.data
}

// Chart snapshot URL helper
export function chartUrl(path) {
  if (!path) return null
  const filename = path.replace(/^\/snapshots\//, "")
  return `${CHART_URL}/snapshots/${filename}`
}

// MCP Config: built-in + user-added MCP servers, tool discovery and testing
export async function listMcps() {
  const response = await connectorApi.get("/api/mcps")
  return response.data
}

export async function createMcp(mcp) {
  const response = await connectorApi.post("/api/mcps", mcp)
  return response.data
}

export async function updateMcp(id, mcp) {
  const response = await connectorApi.put(`/api/mcps/${encodeURIComponent(id)}`, mcp)
  return response.data
}

export async function deleteMcp(id) {
  const response = await connectorApi.delete(`/api/mcps/${encodeURIComponent(id)}`)
  return response.data
}

export async function listMcpTools(id) {
  const response = await connectorApi.get(`/api/mcps/${encodeURIComponent(id)}/tools`)
  return response.data
}

export async function callMcpTool(id, tool, args) {
  const response = await connectorApi.post(`/api/mcps/${encodeURIComponent(id)}/call`, { tool, arguments: args })
  return response.data
}

// Subscription page: Telegram bot config, connection test, subscribers
export async function getTelegramConfig() {
  const response = await connectorApi.get("/api/telegram/config")
  return response.data
}

export async function saveTelegramConfig(config) {
  const response = await connectorApi.post("/api/telegram/config", config)
  return response.data
}

export async function testTelegramConnection() {
  const response = await connectorApi.post("/api/telegram/test")
  return response.data
}

export async function listPendingTelegramChats() {
  const response = await connectorApi.get("/api/telegram/pending")
  return response.data
}

export async function listTelegramSubscribers() {
  const response = await connectorApi.get("/api/telegram/subscribers")
  return response.data
}

export async function addTelegramSubscriber(subscriber) {
  const response = await connectorApi.post("/api/telegram/subscribers", subscriber)
  return response.data
}

export async function removeTelegramSubscriber(id) {
  const response = await connectorApi.delete(`/api/telegram/subscribers/${encodeURIComponent(id)}`)
  return response.data
}
