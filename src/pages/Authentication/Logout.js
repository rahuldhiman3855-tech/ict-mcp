import React, { useEffect } from "react"
import { withRouter } from "react-router-dom"

import { logout } from "../../helpers/auth_helper"

const Logout = props => {
  useEffect(() => {
    logout()
    props.history.push("/login")
  })

  return <></>
}

export default withRouter(Logout)
