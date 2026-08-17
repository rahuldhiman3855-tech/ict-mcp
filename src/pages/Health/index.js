import React, { useState, useEffect, useCallback } from "react"
import { Container, Row, Col, Card, CardBody, Badge, Button, Spinner, Alert } from "reactstrap"
import Breadcrumb from "../../components/Common/Breadcrumb"
import { getFullHealth } from "../../helpers/connector_helper"

const StatusBadge = ({ ok, label }) => (
  <Badge color={ok ? "success" : "danger"}>{label || (ok ? "OK" : "DOWN")}</Badge>
)

const Health = () => {
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastChecked, setLastChecked] = useState(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const data = await getFullHealth()
      setHealth(data)
      setLastChecked(new Date())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading && !health) return <Spinner />

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Breadcrumb title="Dashboard" breadcrumbItem="Health" />

          {error && <Alert color="danger">{error}</Alert>}

          <Row className="mb-3">
            <Col sm="12" className="d-flex justify-content-between align-items-center">
              <p className="text-muted mb-0">
                {lastChecked && `Last checked ${lastChecked.toLocaleTimeString()}`}
                {health?.tookMs != null && ` · ${health.tookMs}ms`}
              </p>
              <Button size="sm" color="primary" onClick={load} disabled={loading}>
                <i className="mdi mdi-refresh me-1"></i>{loading ? "Testing..." : "Refresh & Test All"}
              </Button>
            </Col>
          </Row>

          {health && (
            <>
              <Row>
                <Col md="3" sm="6" className="mb-3">
                  <Card className="h-100">
                    <CardBody>
                      <h5 className="card-title">Connector</h5>
                      <p className="mb-1">Status: <StatusBadge ok={health.ok} /></p>
                      <p className="mb-1">Service: {health.service}</p>
                      <p className="mb-0">
                        Uptime: {Math.floor(health.uptimeSec / 60)}m {health.uptimeSec % 60}s
                      </p>
                    </CardBody>
                  </Card>
                </Col>

                <Col md="3" sm="6" className="mb-3">
                  <Card className="h-100">
                    <CardBody>
                      <h5 className="card-title">Database</h5>
                      <p className="mb-0">Status: <StatusBadge ok={health.db?.ok} /></p>
                      {health.db?.error && <p className="text-danger small mb-0 mt-1">{health.db.error}</p>}
                    </CardBody>
                  </Card>
                </Col>

                <Col md="3" sm="6" className="mb-3">
                  <Card className="h-100">
                    <CardBody>
                      <h5 className="card-title">Chart Server</h5>
                      <p className="mb-0">Status: <StatusBadge ok={health.chartServer?.ok} /></p>
                      {health.chartServer?.error && <p className="text-danger small mb-0 mt-1">{health.chartServer.error}</p>}
                    </CardBody>
                  </Card>
                </Col>

                <Col md="3" sm="6" className="mb-3">
                  <Card className="h-100">
                    <CardBody>
                      <h5 className="card-title">Cron Jobs</h5>
                      <p className="mb-1">{health.activeCronJobs} workflow(s) actively scheduled</p>
                      <p className="mb-0 small text-muted">
                        Position monitor: <StatusBadge ok={health.positionMonitorActive} label={health.positionMonitorActive ? "active" : "idle"} />
                      </p>
                    </CardBody>
                  </Card>
                </Col>
              </Row>

              <Row>
                <Col md="6" className="mb-3">
                  <Card className="h-100">
                    <CardBody>
                      <h5 className="card-title">Telegram</h5>
                      {!health.telegram?.configured ? (
                        <p className="text-muted mb-0">
                          Not configured — set a bot token on the <a href="/subscription">Subscription</a> page.
                        </p>
                      ) : (
                        <>
                          <p className="mb-1">Connection: <StatusBadge ok={health.telegram.ok} /></p>
                          {health.telegram.ok ? (
                            <p className="mb-1">Bot: @{health.telegram.bot?.username} ({health.telegram.bot?.first_name})</p>
                          ) : (
                            <p className="text-danger small mb-1">{health.telegram.error}</p>
                          )}
                          <p className="mb-0">Subscribers: {health.telegram.subscribers}</p>
                        </>
                      )}
                    </CardBody>
                  </Card>
                </Col>

                <Col md="6" className="mb-3">
                  <Card className="h-100">
                    <CardBody>
                      <h5 className="card-title">Webhook</h5>
                      <p className="mb-0">
                        {health.webhook?.configured
                          ? <StatusBadge ok={true} label="configured" />
                          : <span className="text-muted">Not configured</span>}
                      </p>
                    </CardBody>
                  </Card>
                </Col>
              </Row>

              <Row>
                <Col md="12" className="mb-3">
                  <Card>
                    <CardBody>
                      <h5 className="card-title mb-3">MCPs</h5>
                      <Row>
                        {(health.mcps || []).map((mcp) => (
                          <Col md="4" sm="6" key={mcp.id} className="mb-3">
                            <Card className="h-100 border">
                              <CardBody>
                                <div className="d-flex justify-content-between align-items-start mb-1">
                                  <h6 className="mb-0">{mcp.name}</h6>
                                  <Badge color={mcp.kind === "local" ? "info" : "secondary"}>{mcp.kind}</Badge>
                                </div>
                                <p className="mb-1">Status: <StatusBadge ok={mcp.ok} /> <span className="text-muted small">({mcp.tookMs}ms)</span></p>
                                {mcp.ok
                                  ? <p className="mb-0 small text-muted">{mcp.toolCount} tool(s)</p>
                                  : <p className="mb-0 small text-danger">{mcp.error}</p>}
                                {mcp.url && <p className="mb-0 small text-muted text-truncate">{mcp.url}</p>}
                              </CardBody>
                            </Card>
                          </Col>
                        ))}
                        {!health.mcps?.length && <Col><p className="text-muted small">No MCPs configured.</p></Col>}
                      </Row>
                    </CardBody>
                  </Card>
                </Col>
              </Row>
            </>
          )}
        </Container>
      </div>
    </React.Fragment>
  )
}

export default Health
