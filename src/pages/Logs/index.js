import React, { useState, useEffect } from "react"
import { Container, Row, Col, Card, CardBody, Badge, Input, FormGroup, Spinner, Alert } from "reactstrap"
import { getSignals } from "../../helpers/connector_helper"

const Logs = () => {
  const [logs, setLogs] = useState([])
  const [filter, setFilter] = useState("all")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const loadLogs = async () => {
      try {
        setLoading(true)
        const signals = await getSignals({ limit: 100 })
        const signalList = (signals.signals || []).map((sig, idx) => ({
          id: idx,
          timestamp: new Date(sig.at).toLocaleString(),
          level: sig.verdict ? "info" : "warning",
          symbol: sig.symbol,
          verdict: sig.verdict,
          confidence: sig.confidence,
          message: `${sig.verdict || "HOLD"} (confidence: ${(sig.confidence * 100).toFixed(1)}%)`,
        }))
        setLogs(signalList)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    loadLogs()
  }, [])

  const filteredLogs =
    filter === "all"
      ? logs
      : logs.filter((log) => log.level === filter)

  const getLevelBadge = (level) => {
    switch (level) {
      case "info":
        return <Badge color="info">Info</Badge>
      case "warning":
        return <Badge color="warning">Neutral</Badge>
      default:
        return <Badge color="secondary">Unknown</Badge>
    }
  }

  if (loading) return <Spinner />
  if (error) return <Alert color="danger">{error}</Alert>

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Row className="mb-3">
            <Col sm="6">
              <div className="page-title-box d-sm-flex align-items-center justify-content-between">
                <h4 className="mb-sm-0">Logs</h4>
              </div>
            </Col>
            <Col sm="6" className="text-sm-end">
              <FormGroup className="d-inline-block me-2" style={{ width: "150px" }}>
                <Input
                  type="select"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  size="sm"
                >
                  <option value="all">All Levels</option>
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="error">Error</option>
                </Input>
              </FormGroup>
            </Col>
          </Row>

          <Row>
            <Col lg="12">
              <Card>
                <CardBody>
                  <div className="table-responsive">
                    <table className="table table-hover mb-0">
                      <thead className="table-light">
                        <tr>
                          <th>Timestamp</th>
                          <th>Level</th>
                          <th>Symbol</th>
                          <th>Verdict</th>
                          <th>Confidence</th>
                          <th>Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredLogs.length > 0 ? (
                          filteredLogs.map((log) => (
                            <tr key={log.id}>
                              <td>
                                <small>{log.timestamp}</small>
                              </td>
                              <td>{getLevelBadge(log.level)}</td>
                              <td>
                                <Badge bg="light" text="dark">
                                  {log.symbol}
                                </Badge>
                              </td>
                              <td className="fw-medium">
                                {log.verdict ? (
                                  <Badge color={log.verdict === "BUY" ? "success" : log.verdict === "SELL" ? "danger" : "info"}>
                                    {log.verdict}
                                  </Badge>
                                ) : (
                                  <Badge color="secondary">HOLD</Badge>
                                )}
                              </td>
                              <td>
                                <small>{(log.confidence * 100).toFixed(1)}%</small>
                              </td>
                              <td>
                                <small>{log.message}</small>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan="6" className="text-center text-muted py-5">
                              No signals yet. Run a workflow to generate signals.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardBody>
              </Card>
            </Col>
          </Row>
        </Container>
      </div>
    </React.Fragment>
  )
}

export default Logs
