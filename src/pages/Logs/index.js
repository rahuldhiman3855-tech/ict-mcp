import React, { useState, useEffect } from "react"
import { Container, Row, Col, Card, CardBody, Badge, Collapse, Input, FormGroup, Spinner, Alert } from "reactstrap"
import { getSignals } from "../../helpers/connector_helper"

const STATUS_ICON = {
  ok: { icon: "mdi-check-circle", color: "text-success" },
  error: { icon: "mdi-alert-circle", color: "text-danger" },
}

const getVerdictBadge = (verdict) => {
  if (!verdict) return <Badge color="secondary">—</Badge>
  switch (verdict) {
    case "BUY": return <Badge color="success">BUY</Badge>
    case "SELL": return <Badge color="danger">SELL</Badge>
    case "HOLD": return <Badge color="info">HOLD</Badge>
    default: return <Badge color="secondary">{verdict}</Badge>
  }
}

const Logs = () => {
  const [runs, setRuns] = useState([])
  const [filter, setFilter] = useState("all")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openIds, setOpenIds] = useState(new Set())

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true)
        const data = await getSignals({ limit: 100 })
        setRuns(data.signals || [])
        setError(null)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const toggle = (id) => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filteredRuns = filter === "all"
    ? runs
    : filter === "error"
      ? runs.filter((r) => r.error)
      : runs.filter((r) => r.verdict === filter)

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
              <FormGroup className="d-inline-block me-2" style={{ width: "180px" }}>
                <Input type="select" value={filter} onChange={(e) => setFilter(e.target.value)} size="sm">
                  <option value="all">All Runs</option>
                  <option value="BUY">BUY</option>
                  <option value="SELL">SELL</option>
                  <option value="HOLD">HOLD</option>
                  <option value="error">Errors</option>
                </Input>
              </FormGroup>
            </Col>
          </Row>

          {filteredRuns.map((run) => {
            const isOpen = openIds.has(run.id)
            return (
              <Card key={run.id} className="mb-2">
                <div
                  className="card-body d-flex justify-content-between align-items-center"
                  style={{ cursor: "pointer" }}
                  onClick={() => toggle(run.id)}
                >
                  <div className="d-flex align-items-center gap-3">
                    <i className={`mdi ${isOpen ? "mdi-chevron-down" : "mdi-chevron-right"}`}></i>
                    <small className="text-muted">{new Date(run.at).toLocaleString()}</small>
                    <span className="fw-medium">{run.workflowName || run.label || run.symbol}</span>
                    <Badge bg="light" text="dark">{run.symbol}</Badge>
                    {getVerdictBadge(run.verdict)}
                    {run.error && <Badge color="danger">error</Badge>}
                  </div>
                  <small className="text-muted">{run.agents?.length || 0} step(s)</small>
                </div>
                <Collapse isOpen={isOpen}>
                  <CardBody className="border-top pt-3">
                    {run.error && <Alert color="danger">{run.error}</Alert>}
                    {run.rationale && <p className="mb-3">{run.rationale}</p>}
                    {(run.agents || []).map((agent) => {
                      const style = STATUS_ICON[agent.status] || { icon: "mdi-circle-outline", color: "text-muted" }
                      return (
                        <div key={agent.id} className="mb-3 pb-3 border-bottom">
                          <div className="fw-medium mb-2">
                            <i className={`mdi ${style.icon} ${style.color} me-1`}></i>
                            {agent.label}
                            {agent.latencyMs != null && <small className="text-muted ms-2">{agent.latencyMs}ms</small>}
                          </div>
                          {agent.error && <Alert color="danger" className="py-1 px-2 small">{agent.error}</Alert>}
                          {agent.input && (
                            <div className="mb-2">
                              <small className="text-muted d-block mb-1">Input / data given to this step:</small>
                              <pre className="small bg-light p-2 rounded" style={{ whiteSpace: "pre-wrap", maxHeight: "200px", overflow: "auto" }}>
                                {agent.input}
                              </pre>
                            </div>
                          )}
                          {agent.output && (
                            <div>
                              <small className="text-muted d-block mb-1">Reasoning / output:</small>
                              <pre className="small bg-light p-2 rounded" style={{ whiteSpace: "pre-wrap", maxHeight: "300px", overflow: "auto" }}>
                                {agent.output}
                              </pre>
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {!run.agents?.length && <p className="text-muted small mb-0">No per-step trace recorded for this run.</p>}
                  </CardBody>
                </Collapse>
              </Card>
            )
          })}

          {!filteredRuns.length && (
            <Card><CardBody className="text-center text-muted py-5">No runs yet. Trigger a workflow to generate logs.</CardBody></Card>
          )}
        </Container>
      </div>
    </React.Fragment>
  )
}

export default Logs
