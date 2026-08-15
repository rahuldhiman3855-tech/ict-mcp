import axios from "axios"

const API_URL = process.env.REACT_APP_MCP_CONNECTOR_URL || "http://localhost:3002"

const authApi = axios.create({
  baseURL: API_URL,
  headers: { "content-type": "application/json" },
})

// Add JWT token to all requests
authApi.interceptors.request.use((config) => {
  const token = localStorage.getItem("jwt_token")
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Handle token expiration.
// Skips the auth endpoints: they answer 401 for bad credentials, and redirecting
// there would reload the page before the form could show why sign-in failed.
authApi.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status
    const isAuthRequest = /\/api\/auth\/(login|register)$/.test(
      error.config?.url || ""
    )
    if ((status === 403 || status === 401) && !isAuthRequest) {
      localStorage.removeItem("jwt_token")
      window.location.href = "/login"
    }
    return Promise.reject(error)
  }
)

export async function register(email, password) {
  const response = await authApi.post("/api/auth/register", { email, password })
  localStorage.setItem("jwt_token", response.data.token)
  return response.data
}

export async function login(email, password) {
  const response = await authApi.post("/api/auth/login", { email, password })
  localStorage.setItem("jwt_token", response.data.token)
  return response.data
}

export function logout() {
  localStorage.removeItem("jwt_token")
}

export function getToken() {
  return localStorage.getItem("jwt_token")
}

export async function getCurrentUser() {
  const response = await authApi.get("/api/auth/me")
  return response.data
}

export async function getDashboardConfig() {
  const response = await authApi.get("/api/dashboard/config")
  return response.data.config
}

export async function saveDashboardConfig(config) {
  const response = await authApi.put("/api/dashboard/config", config)
  return response.data.config
}

export async function getSettings() {
  const response = await authApi.get("/api/settings")
  return response.data
}

export async function saveSettings(data) {
  const response = await authApi.post("/api/settings", data)
  return response.data
}
