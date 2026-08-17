import React, { useState, useEffect } from "react"
import {
  Container, Row, Col, Card, CardBody, Badge, Button, Spinner, Alert,
  Modal, ModalHeader, ModalBody, ModalFooter, Form, FormGroup, Label, Input,
} from "reactstrap"
import Breadcrumb from "../../components/Common/Breadcrumb"
import { listAgents, createAgent, updateAgent, deleteAgent } from "../../helpers/connector_helper"

const EMPTY_FORM = { name: "", systemPrompt: "", temperature: 0.3, maxTokens: 1024, vision: false }

const Agents = () => {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [editing, setEditing] = useState(null) // null = closed, {} = new, {...} = editing
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const data = await listAgents()
      setAgents(data.agents || [])
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const openNew = () => { setForm(EMPTY_FORM); setEditing({}) }
  const openEdit = (agent) => {
    setForm({
      name: agent.name,
      systemPrompt: agent.system_prompt,
      temperature: agent.temperature,
      maxTokens: agent.max_tokens,
      vision: Boolean(agent.vision),
    })
    setEditing(agent)
  }
  const close = () => setEditing(null)

  const handleChange = (e) => {
    const { name, type, checked, value } = e.target
    setForm({ ...form, [name]: type === "checkbox" ? checked : value })
  }

  const handleSave = async (e) => {
    e.preventDefault()
    try {
      setSaving(true)
      setError(null)
      if (editing?.id) await updateAgent(editing.id, form)
      else await createAgent(form)
      close()
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (agent) => {
    try {
      await deleteAgent(agent.id)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  if (loading) return <Spinner />

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Breadcrumb title="Dashboard" breadcrumbItem="Agents" />

          {error && <Alert color="danger">{error}</Alert>}

          <Row className="mb-3">
            <Col className="d-flex justify-content-end">
              <Button color="primary" onClick={openNew}>
                <i className="mdi mdi-plus me-1"></i>New Agent
              </Button>
            </Col>
          </Row>

          <Row>
            {agents.map((agent) => {
              const isMechanical = agent.kind === "mechanical"
              return (
                <Col md="6" lg="4" key={agent.id} className="mb-3">
                  <Card className={`h-100${isMechanical ? " border-info" : ""}`}>
                    <CardBody>
                      <div className="d-flex justify-content-between align-items-start mb-2">
                        <h5 className="card-title mb-0">{agent.name}</h5>
                        {isMechanical
                          ? <Badge color="warning">mechanical</Badge>
                          : Boolean(agent.vision) && <Badge color="info">vision</Badge>}
                      </div>
                      {isMechanical ? (
                        <p className="text-muted small">{agent.description}</p>
                      ) : (
                        <>
                          <p className="text-muted small" style={{ maxHeight: "4.5em", overflow: "hidden" }}>
                            {agent.system_prompt}
                          </p>
                          <div className="small text-muted mb-3">
                            temp {agent.temperature} · max {agent.max_tokens} tokens
                          </div>
                        </>
                      )}
                      {isMechanical ? (
                        <small className="text-muted">
                          Fixed — configure its shared parameters on the <a href="/settings">Settings</a> page.
                        </small>
                      ) : (
                        <div className="d-flex gap-2">
                          <Button size="sm" color="secondary" outline onClick={() => openEdit(agent)}>
                            <i className="mdi mdi-pencil"></i>
                          </Button>
                          <Button size="sm" color="danger" outline onClick={() => handleDelete(agent)}>
                            <i className="mdi mdi-delete"></i>
                          </Button>
                        </div>
                      )}
                    </CardBody>
                  </Card>
                </Col>
              )
            })}
            {!agents.length && (
              <Col><p className="text-muted">No agents yet. Create one to start building a workflow.</p></Col>
            )}
          </Row>
        </Container>
      </div>

      <Modal isOpen={Boolean(editing)} toggle={close} size="lg">
        <ModalHeader toggle={close}>{editing?.id ? "Edit Agent" : "New Agent"}</ModalHeader>
        <Form onSubmit={handleSave}>
          <ModalBody>
            <FormGroup className="mb-3">
              <Label>Name</Label>
              <Input type="text" name="name" value={form.name} onChange={handleChange} required />
            </FormGroup>
            <FormGroup className="mb-3">
              <Label>System Prompt</Label>
              <Input
                type="textarea"
                name="systemPrompt"
                rows={8}
                value={form.systemPrompt}
                onChange={handleChange}
                required
                placeholder="You are a market analyst. Given the facts and prior agent outputs below, ..."
              />
            </FormGroup>
            <Row>
              <Col md="4">
                <FormGroup className="mb-3">
                  <Label>Temperature</Label>
                  <Input type="number" step="0.1" min="0" max="2" name="temperature" value={form.temperature} onChange={handleChange} />
                </FormGroup>
              </Col>
              <Col md="4">
                <FormGroup className="mb-3">
                  <Label>Max Tokens</Label>
                  <Input type="number" step="1" min="1" max="8000" name="maxTokens" value={form.maxTokens} onChange={handleChange} />
                </FormGroup>
              </Col>
              <Col md="4">
                <FormGroup className="mb-3">
                  <Label>&nbsp;</Label>
                  <div className="form-check mt-2">
                    <input type="checkbox" className="form-check-input" id="vision" name="vision" checked={form.vision} onChange={handleChange} />
                    <label className="form-check-label" htmlFor="vision">Receives chart image</label>
                  </div>
                </FormGroup>
              </Col>
            </Row>
          </ModalBody>
          <ModalFooter>
            <Button color="secondary" outline type="button" onClick={close}>Cancel</Button>
            <Button color="primary" type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          </ModalFooter>
        </Form>
      </Modal>
    </React.Fragment>
  )
}

export default Agents
