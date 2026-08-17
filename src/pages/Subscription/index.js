import React, { useState, useEffect, useCallback } from "react"
import {
  Container, Row, Col, Card, CardBody, Table, Button, Spinner, Alert,
  Form, FormGroup, Label, Input, Badge,
} from "reactstrap"
import Breadcrumb from "../../components/Common/Breadcrumb"
import {
  getTelegramConfig, saveTelegramConfig, testTelegramConnection,
  listPendingTelegramChats, listTelegramSubscribers,
  addTelegramSubscriber, removeTelegramSubscriber,
} from "../../helpers/connector_helper"

const Subscription = () => {
  const [config, setConfig] = useState({ telegramBotToken: "", telegramBotTokenSet: false, webhookUrl: "" })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)

  const [testing, setTesting] = useState(false)
  const [connection, setConnection] = useState(null)

  const [pending, setPending] = useState([])
  const [pendingLoading, setPendingLoading] = useState(false)
  const [pendingError, setPendingError] = useState(null)

  const [subscribers, setSubscribers] = useState([])
  const [manualChatId, setManualChatId] = useState("")
  const [manualName, setManualName] = useState("")

  const loadAll = useCallback(async () => {
    try {
      setLoading(true)
      const [cfg, subs] = await Promise.all([getTelegramConfig(), listTelegramSubscribers()])
      setConfig((c) => ({ ...c, ...cfg, telegramBotToken: "" }))
      setSubscribers(subs.subscribers || [])
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const handleConfigChange = (e) => setConfig({ ...config, [e.target.name]: e.target.value })

  const handleSaveConfig = async (e) => {
    e.preventDefault()
    try {
      setSaving(true)
      setError(null)
      setSuccess(null)
      const patch = { webhookUrl: config.webhookUrl }
      if (config.telegramBotToken) patch.telegramBotToken = config.telegramBotToken
      const data = await saveTelegramConfig(patch)
      setConfig((c) => ({ ...c, ...data, telegramBotToken: "" }))
      setSuccess("Telegram config saved.")
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleTestConnection = async () => {
    try {
      setTesting(true)
      setConnection(null)
      const data = await testTelegramConnection()
      setConnection(data)
    } catch (err) {
      setConnection({ ok: false, error: err.message })
    } finally {
      setTesting(false)
    }
  }

  const loadPending = async () => {
    try {
      setPendingLoading(true)
      setPendingError(null)
      const data = await listPendingTelegramChats()
      setPending(data.pending || [])
    } catch (err) {
      setPendingError(err.message)
    } finally {
      setPendingLoading(false)
    }
  }

  const subscribe = async (chat) => {
    try {
      await addTelegramSubscriber(chat)
      setPending((p) => p.filter((c) => c.chatId !== chat.chatId))
      await loadAll()
    } catch (err) {
      setError(err.message)
    }
  }

  const subscribeManual = async (e) => {
    e.preventDefault()
    if (!manualChatId.trim()) return
    try {
      await addTelegramSubscriber({ chatId: manualChatId.trim(), name: manualName.trim() || undefined })
      setManualChatId("")
      setManualName("")
      await loadAll()
    } catch (err) {
      setError(err.message)
    }
  }

  const unsubscribe = async (sub) => {
    try {
      await removeTelegramSubscriber(sub.id)
      setSubscribers((s) => s.filter((x) => x.id !== sub.id))
    } catch (err) {
      setError(err.message)
    }
  }

  if (loading) return <Spinner />

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Breadcrumb title="Dashboard" breadcrumbItem="Subscription" />

          {error && <Alert color="danger">{error}</Alert>}
          {success && <Alert color="success">{success}</Alert>}

          <Row>
            <Col lg="8">
              <Card>
                <CardBody>
                  <h5 className="card-title mb-3">Telegram Bot</h5>
                  <p className="text-muted small">
                    Configure the bot once here, test the connection, then let users subscribe below.
                  </p>
                  <Form onSubmit={handleSaveConfig}>
                    <FormGroup className="mb-3">
                      <Label>Bot Token</Label>
                      <Input
                        type="password"
                        name="telegramBotToken"
                        value={config.telegramBotToken || ""}
                        onChange={handleConfigChange}
                        placeholder={config.telegramBotTokenSet ? `Current: ${config.telegramBotToken || "set"} — leave blank to keep it` : "Not set"}
                      />
                    </FormGroup>
                    <FormGroup className="mb-3">
                      <Label>Webhook URL (optional, generic)</Label>
                      <Input type="text" name="webhookUrl" value={config.webhookUrl || ""} onChange={handleConfigChange} />
                    </FormGroup>
                    <div className="d-flex gap-2">
                      <Button color="primary" type="submit" disabled={saving}>
                        {saving ? "Saving..." : "Save Config"}
                      </Button>
                      <Button color="info" outline type="button" onClick={handleTestConnection} disabled={testing}>
                        <i className="mdi mdi-connection me-1"></i>
                        {testing ? "Testing..." : "Test Connection"}
                      </Button>
                    </div>

                    {connection && (
                      <Alert className="mt-3" color={connection.ok ? "success" : "danger"}>
                        {connection.ok
                          ? `Connected to @${connection.bot.username} (${connection.bot.first_name}).`
                          : connection.error}
                      </Alert>
                    )}
                  </Form>
                </CardBody>
              </Card>
            </Col>
          </Row>

          <Row>
            <Col lg="8">
              <Card>
                <CardBody>
                  <div className="d-flex justify-content-between align-items-center mb-3">
                    <h5 className="card-title mb-0">Discover chats</h5>
                    <Button size="sm" color="secondary" outline onClick={loadPending} disabled={pendingLoading}>
                      {pendingLoading ? "Checking..." : "Check for new messages"}
                    </Button>
                  </div>
                  <p className="text-muted small">
                    Have a user message the bot on Telegram, then click above — they'll show up here to subscribe.
                  </p>

                  {pendingError && <Alert color="danger">{pendingError}</Alert>}

                  {pending.length > 0 && (
                    <Table size="sm" className="mb-3">
                      <thead>
                        <tr><th>Name</th><th>Chat ID</th><th>Type</th><th></th></tr>
                      </thead>
                      <tbody>
                        {pending.map((chat) => (
                          <tr key={chat.chatId}>
                            <td>{chat.name}{chat.username ? ` (@${chat.username})` : ""}</td>
                            <td><code>{chat.chatId}</code></td>
                            <td>{chat.type}</td>
                            <td>
                              <Button size="sm" color="success" onClick={() => subscribe(chat)}>
                                Subscribe
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  )}

                  <Form onSubmit={subscribeManual} className="d-flex gap-2 align-items-end flex-wrap">
                    <FormGroup className="mb-0">
                      <Label className="small">Or add by chat ID</Label>
                      <Input
                        type="text"
                        value={manualChatId}
                        onChange={(e) => setManualChatId(e.target.value)}
                        placeholder="e.g. 767379280"
                        style={{ width: 200 }}
                      />
                    </FormGroup>
                    <FormGroup className="mb-0">
                      <Label className="small">Name (optional)</Label>
                      <Input
                        type="text"
                        value={manualName}
                        onChange={(e) => setManualName(e.target.value)}
                        style={{ width: 200 }}
                      />
                    </FormGroup>
                    <Button color="primary" type="submit">Add Subscriber</Button>
                  </Form>
                </CardBody>
              </Card>
            </Col>
          </Row>

          <Row>
            <Col lg="8">
              <Card>
                <CardBody>
                  <h5 className="card-title mb-3">
                    Subscribed Users <Badge color="secondary">{subscribers.length}</Badge>
                  </h5>
                  <Table size="sm">
                    <thead>
                      <tr><th>Name</th><th>Chat ID</th><th>Type</th><th>Subscribed</th><th></th></tr>
                    </thead>
                    <tbody>
                      {subscribers.map((sub) => (
                        <tr key={sub.id}>
                          <td>{sub.name}{sub.username ? ` (@${sub.username})` : ""}</td>
                          <td><code>{sub.chatId}</code></td>
                          <td>{sub.type}</td>
                          <td className="text-muted small">{new Date(sub.subscribedAt).toLocaleString()}</td>
                          <td>
                            <Button size="sm" color="danger" outline onClick={() => unsubscribe(sub)}>
                              <i className="mdi mdi-delete"></i>
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  {!subscribers.length && <p className="text-muted small">No subscribers yet.</p>}
                </CardBody>
              </Card>
            </Col>
          </Row>
        </Container>
      </div>
    </React.Fragment>
  )
}

export default Subscription
