import PropTypes from "prop-types"
import React, { useEffect, useState } from "react"
import { Row, Col, Card, Alert, Container } from "reactstrap"
import { AvForm, AvField } from "availity-reactstrap-validation"
import { Link, withRouter } from "react-router-dom"

import logo from "../../assets/images/logo-sm-dark.png"
import { register } from "../../helpers/auth_helper"

const Register = props => {
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleValidSubmit = async (event, values) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(false)
    try {
      await register(values.email, values.password)
      setSuccess(true)
      setTimeout(() => {
        props.history.push("/")
      }, 1500)
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    document.body.className = "authentication-bg";
    return function cleanup() {
      document.body.className = "";
    };
  });

  return (
    <React.Fragment>
      <div className="home-btn d-none d-sm-block">
        <Link to="/" className="text-dark">
          <i className="fas fa-home h2"></i>
        </Link>
      </div>
      <div className="account-pages my-5 pt-sm-5">
        <Container>
          <Row className="justify-content-center">
            <Col md={8} lg={6} xl={5}>
              <Card className="overflow-hidden">
                <div className="bg-login text-center">
                  <div className="bg-login-overlay"></div>
                  <div className="position-relative">
                    <h5 className="text-white font-size-20">Create Account</h5>
                    <p className="text-white-50 mb-0">Get started with ICT Cron Manager</p>
                    <Link to="/" className="logo logo-admin mt-4">
                      <img src={logo} alt="" height="30" />
                    </Link>
                  </div>
                </div>
                <div className="card-body pt-5">

                  <div className="p-2">
                    <AvForm
                      className="form-horizontal"
                      onValidSubmit={handleValidSubmit}
                    >
                      {success && (
                        <Alert color="success">
                          Account created successfully! Redirecting...
                        </Alert>
                      )}

                      {error && (
                        <Alert color="danger">
                          {error}
                        </Alert>
                      )}

                      <div className="mb-3">
                        <AvField
                          id="email"
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
                          placeholder="Enter Password (min 6 chars)"
                        />
                      </div>

                      <div className="mt-4">
                        <button
                          className="btn btn-primary w-100 waves-effect waves-light"
                          type="submit"
                          disabled={loading}
                        >
                          {loading ? "Creating account..." : "Register"}
                        </button>
                      </div>
                    </AvForm>

                  </div>
                </div>
              </Card>
              <div className="mt-5 text-center">
                <p>Already have an account ? <Link to="/login" className="fw-medium text-primary">
                  Login</Link> </p>
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

Register.propTypes = {
  history: PropTypes.object,
}

export default withRouter(Register)
