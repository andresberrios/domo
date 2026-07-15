export default defineEventHandler(async (event) => {
  const runtime = event.context.$electricAgentsRuntime
  return runtime.handleWebhookRequest(toWebRequest(event))
})
