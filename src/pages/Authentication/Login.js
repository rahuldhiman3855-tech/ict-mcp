import PropTypes from 'prop-types'
import React, { useEffect, useState } from "react"

import { Row, Col, Alert, Container } from "reactstrap"
import { withRouter, Link } from "react-router-dom"
import { AvForm, AvField } from "availity-reactstrap-validation"

import { login } from "../../helpers/auth_helper"

// Same brand mark as the topbar, rather than the stock theme logo.
const logo = "/icon.svg"

const Login = (props) => {
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    document.body.className = "authentication-bg";
    return function cleanup() {
      document.body.className = "";
    };
  });

  const handleValidSubmit = async (event, values) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await login(values.email, values.password)
      props.history.push("/")
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <React.Fragment>
      <div className="home-btn d-none d-sm-block">
        <Link to="/" className="text-dark">
          <i className="fas fa-home h2" />
        </Link>
      </div>
      <div className="account-pages my-5 pt-sm-5">
        <Container>
          <Row className="justify-content-center">
            <Col md={8} lg={6} xl={5}>
              <div className="card overflow-hidden">
                <div className="bg-login text-center">
                  <div className="bg-login-overlay"></div>
                  <div className="position-relative">
                    <h5 className="text-white font-size-20">Welcome Back !</h5>
                    <p className="text-white-50 mb-0">Sign in to ICT Cron Manager</p>
                    <Link to="/" className="logo logo-admin mt-4">
                      <img src={logo} alt="ICT Cron Manager" height="72" />
                    </Link>
                  </div>
                </div>
                <div className="card-body pt-5">
                  <div className="p-2">
                    <AvForm
                      className="form-horizontal"
                      onValidSubmit={handleValidSubmit}
                    >
                      {error && (
                        <Alert color="danger">{error}</Alert>
                      )}

                      <div className="mb-3">
                        <AvField
                          name="email"
                          label="Email"
                          className="form-control"
                          placeholder="Enter email"
                          type="email"
                          required
                        />
                      </div>

                      <div className="mb-3">
                        <AvField
                          name="password"
                          label="Password"
                          type="password"
                          required
                          placeholder="Enter Password"
                        />
                      </div>

                      <div className="mt-3">
                        <button
                          className="btn btn-primary w-100 waves-effect waves-light"
                          type="submit"
                          disabled={loading}
                        >
                          {loading ? "Logging in..." : "Log In"}
                        </button>
                      </div>
                    </AvForm>

                  </div>
                </div>
              </div>
              <div className="mt-5 text-center">
                <p>© {new Date().getFullYear()} ICT Cron Manager. Made with <i
                  className="mdi mdi-heart text-danger"></i> by Rahul Dhiman
                        </p>
              </div>
            </Col>
          </Row>

        </Container>
      </div>
    </React.Fragment>
  )
}

export default withRouter(Login)

Login.propTypes = {
  history: PropTypes.object,
}