import React, { useState, useEffect, useCallback } from "react"
import { Container, Row, Col, Card, CardBody, Badge, Button, Spinner, Alert } from "reactstrap"
import {
  listWorkflows, runWorkflow, startWorkflowSchedule, stopWorkflowSchedule,
} from "../../helpers/connector_helper"

const Crons = () => {
  const [workflows, setWorkflows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const data = await listWorkflows()
      setWorkflows((data.workflows || []).filter((w) => w.cron_expression))
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleToggle = async (wf) => {
    try {
      setBusy(wf.id)
      if (wf.enabled) await stopWorkflowSchedule(wf.id)
      else await startWorkflowSchedule(wf.id)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const handleTrigger = async (wf) => {
    try {
      setBusy(wf.id)
      await runWorkflow(wf.id)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <Spinner />

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Row className="mb-3">
            <Col sm="12">
              <div className="page-title-box d-sm-flex align-items-center justify-content-between">
                <h4 className="mb-0">Crons</h4>
                <small className="text-muted">Scheduled workflow runs — create/edit schedules on the Workflows page.</small>
              </div>
            </Col>
          </Row>

          {error && <Alert color="danger">{error}</Alert>}

          <Row>
            <Col lg="12">
              <Card>
                <CardBody>
                  <div className="table-responsive">
                    <table className="table table-hover mb-0">
                      <thead className="table-light">
                        <tr>
                          <th>Workflow</th>
                          <th>Symbol</th>
                          <th>Cron</th>
                          <th>Status</th>
                          <th>Last Run</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workflows.map((wf) => (
                          <tr key={wf.id}>
                            <td className="fw-medium">{wf.name}</td>
                            <td><Badge color="light" className="text-dark">{wf.symbol}</Badge></td>
                            <td><code>{wf.cron_expression}</code></td>
                            <td>
                              <Badge color={wf.enabled ? "success" : "secondary"}>
                                {wf.enabled ? "Active" : "Stopped"}
                              </Badge>
                            </td>
                            <td><small>{wf.last_run_at ? new Date(wf.last_run_at).toLocaleString() : "—"}</small></td>
                            <td>
                              <div className="d-flex gap-2">
                                <Button
                                  size="sm"
                                  color={wf.enabled ? "warning" : "success"}
                                  disabled={busy === wf.id}
                                  onClick={() => handleToggle(wf)}
                                >
                                  <i className={`mdi ${wf.enabled ? "mdi-stop" : "mdi-play"} me-1`}></i>
                                  {wf.enabled ? "Stop" : "Start"}
                                </Button>
                                <Button size="sm" color="info" outline disabled={busy === wf.id} onClick={() => handleTrigger(wf)}>
                                  <i className="mdi mdi-lightning-bolt me-1"></i>Run Now
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {!workflows.length && (
                          <tr>
                            <td colSpan="6" className="text-center text-muted py-5">
                              No scheduled workflows. Add a cron expression to a workflow to see it here.
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

export default Crons
