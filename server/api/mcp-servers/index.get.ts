import { listMcpServers } from '../../lib/repo'

export default defineEventHandler(async () => listMcpServers())
