import React from "react"
import { Redirect } from "react-router-dom"

// Pages
import Workflows from "../pages/Workflows/index"
import Agents from "../pages/Agents/index"
import Crons from "../pages/Crons/index"
import Logs from "../pages/Logs/index"
import Settings from "../pages/Settings/index"
import Health from "../pages/Health/index"
import MCPConfig from "../pages/MCPConfig/index"
import Subscription from "../pages/Subscription/index"

// Authentication related pages
import Login from "../pages/Authentication/Login"
import Logout from "../pages/Authentication/Logout"
import ForgetPwd from "../pages/Authentication/ForgetPassword"

// Profile
import UserProfile from "../pages/Authentication/user-profile"

// Error pages
import Pages404 from "../pages/Utility/pages-404"
import Pages500 from "../pages/Utility/pages-500"

const userRoutes = [
  { path: "/workflows", component: Workflows },
  { path: "/agents", component: Agents },
  { path: "/crons", component: Crons },
  { path: "/logs", component: Logs },
  { path: "/settings", component: Settings },
  { path: "/health", component: Health },
  { path: "/mcp-config", component: MCPConfig },
  { path: "/subscription", component: Subscription },
  { path: "/profile", component: UserProfile },

  // this route should be at the end of all other routes
  { path: "/", exact: true, component: () => <Redirect to="/workflows" /> },
]

const authRoutes = [
  { path: "/logout", component: Logout },
  { path: "/login", component: Login },
  { path: "/forgot-password", component: ForgetPwd },

  { path: "/pages-404", component: Pages404 },
  { path: "/pages-500", component: Pages500 },
]

export { userRoutes, authRoutes }
