import React, { useState, useEffect, useCallback } from "react"
import {
  Container, Row, Col, Card, CardBody, Button, Spinner, Alert,
  Modal, ModalHeader, ModalBody, ModalFooter, Form, FormGroup, Label, Input,
} from "reactstrap"
import { getAgents, updateAgent } from "../../helpers/connector_helper"

/**
 * reactstrap 8 emits Bootstrap 4 badge classes; the theme carries a shim for
 * `.badge-*`, but spelling the v5 classes out here keeps this page independent
 * of it.
 */
const Pill = ({ color, children }) => (
  <span className={`badge bg-${color} ${color === "warning" ? "text-dark" : ""}`}>
    {children}
  </span>
)

const Agents = () => {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(null)      // agent id currently being saved
  const [editing, setEditing] = useState(null) // draft copy shown in the modal

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const data = await getAgents()
      setAgents(data.agents || [])
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const patch = useCallback(async (id, changes, message) => {
    setBusy(id)
    setError(null)
    setNotice(null)
    try {
      const { agent } = await updateAgent(id, changes)
      setAgents(list => list.map(a => (a.id === id ? agent : a)))
      setNotice(message)
      return true
    } catch (err) {
      setError(err.response?.data?.error || err.message)
      return false
    } finally {
      setBusy(null)
    }
  }, [])

  const toggle = useCallback((agent) => {
    patch(
      agent.id,
      { enabled: !agent.enabled },
      `${agent.label} ${agent.enabled ? "disabled" : "enabled"}.`
    )
  }, [patch])

  const saveEdit = useCallback(async () => {
    const ok = await patch(editing.id, {
      name: editing.label,
      description: editing.description,
      temperature: Number(editing.temperature),
      maxTokens: Number(editing.maxTokens),
      systemPrompt: editing.systemPrompt,
    }, `${editing.label} updated.`)
    if (ok) setEditing(null)
  }, [editing, patch])

  if (loading) {
    return <div className="page-content"><Container fluid><Spinner /></Container></div>
  }

  const enabledCount = agents.filter(a => a.enabled).length

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Row className="mb-3">
            <Col sm="12">
              <div className="page-title-box d-sm-flex align-items-center justify-content-between">
                <div>
                  <h4 className="mb-0">MCP Agents ({agents.length})</h4>
                  <small className="text-muted">
                    {enabledCount} enabled · changes apply to scheduled runs too
                  </small>
                </div>
              </div>
            </Col>
          </Row>

          {error && <Alert color="danger" toggle={() => setError(null)}>{error}</Alert>}
          {notice && <Alert color="success" toggle={() => setNotice(null)}>{notice}</Alert>}

          <Row>
            {agents.map(agent => (
              <Col lg="6" key={agent.id} className="mb-4">
                <Card className={agent.enabled ? "" : "opacity-75"}>
                  <CardBody>
                    <div className="d-flex justify-content-between align-items-start mb-3">
                      <div>
                        <h5 className="card-title mb-1">{agent.label}</h5>
                        <div className="d-flex gap-2 align-items-center">
                          <Pill color={agent.enabled ? "success" : "secondary"}>
                            {agent.enabled ? "Enabled" : "Disabled"}
                          </Pill>
                          {agent.vision && <Pill color="dark">vision</Pill>}
                          <small className="text-muted">{agent.id}</small>
                        </div>
                      </div>
                      <Pill color="info">{agent.type || "agent"}</Pill>
                    </div>

                    {agent.description && (
                      <p className="text-muted mb-3"><small>{agent.description}</small></p>
                    )}

                    <Row className="mb-3">
                      {[
                        ["Temperature", agent.temperature],
                        ["Max tokens", agent.maxTokens],
                        ["Prompt", `${(agent.systemPrompt || "").length} chars`],
                      ].map(([label, value]) => (
                        <Col xs="4" key={label}>
                          <small className="text-muted d-block">{label}</small>
                          <span className="fw-medium">{value}</span>
                        </Col>
                      ))}
                    </Row>

                    <div className="mt-3 pt-3 border-top">
                      <Button
                        size="sm"
                        color="primary"
                        outline
                        className="me-2"
                        disabled={busy === agent.id}
                        onClick={() => setEditing({ ...agent })}
                      >
                        <i className="mdi mdi-pencil me-1" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        color={agent.enabled ? "warning" : "success"}
                        outline
                        disabled={busy === agent.id}
                        onClick={() => toggle(agent)}
                      >
                        {busy === agent.id
                          ? <Spinner size="sm" />
                          : <>
                              <i className={`mdi ${agent.enabled ? "mdi-pause" : "mdi-play"} me-1`} />
                              {agent.enabled ? "Disable" : "Enable"}
                            </>}
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              </Col>
            ))}
          </Row>

          {agents.length === 0 && (
            <Card><CardBody className="text-center text-muted py-5">
              <p className="mb-0">No agents configured</p>
            </CardBody></Card>
          )}
        </Container>
      </div>

      {/*
        The form is noValidate on purpose: native constraint validation blocks
        submit *silently* inside a modal — no bubble appears, the click simply
        does nothing. The server validates these fields and returns a readable
        message, so it is the authority.
      */}
      <Modal isOpen={!!editing} toggle={() => setEditing(null)} size="lg">
        {editing && (
          <Form noValidate onSubmit={e => { e.preventDefault(); saveEdit() }}>
            <ModalHeader toggle={() => setEditing(null)}>
              Edit {editing.id}
            </ModalHeader>
            <ModalBody>
              <FormGroup>
                <Label for="agent-name">Name</Label>
                <Input
                  id="agent-name"
                  value={editing.label || ""}
                  onChange={e => setEditing({ ...editing, label: e.target.value })}
                />
              </FormGroup>
              <FormGroup>
                <Label for="agent-desc">Description</Label>
                <Input
                  id="agent-desc"
                  value={editing.description || ""}
                  onChange={e => setEditing({ ...editing, description: e.target.value })}
                />
              </FormGroup>
              <Row>
                <Col md="6">
                  <FormGroup>
                    <Label for="agent-temp">Temperature (0–2)</Label>
                    <Input
                      id="agent-temp" type="number" step="0.05" min="0" max="2"
                      value={editing.temperature}
                      onChange={e => setEditing({ ...editing, temperature: e.target.value })}
                    />
                  </FormGroup>
                </Col>
                <Col md="6">
                  <FormGroup>
                    <Label for="agent-tokens">Max tokens (1–8000)</Label>
                    <Input
                      id="agent-tokens" type="number" step="1" min="1" max="8000"
                      value={editing.maxTokens}
                      onChange={e => setEditing({ ...editing, maxTokens: e.target.value })}
                    />
                  </FormGroup>
                </Col>
              </Row>
              <FormGroup className="mb-0">
                <Label for="agent-prompt">System prompt</Label>
                <Input
                  id="agent-prompt" type="textarea" rows="14"
                  style={{ fontFamily: "monospace", fontSize: "12px" }}
                  value={editing.systemPrompt || ""}
                  onChange={e => setEditing({ ...editing, systemPrompt: e.target.value })}
                />
                <small className="text-muted">
                  The ICT facts for the symbol are appended to this at run time.
                </small>
              </FormGroup>
            </ModalBody>
            <ModalFooter>
              <Button color="secondary" outline onClick={() => setEditing(null)}>Cancel</Button>
              <Button color="primary" type="submit" disabled={busy === editing.id}>
                {busy === editing.id ? <Spinner size="sm" /> : "Save changes"}
              </Button>
            </ModalFooter>
          </Form>
        )}
      </Modal>
    </React.Fragment>
  )
}

export default Agents
