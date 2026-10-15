import { listAttachmentNames } from '../../../lib/repo'

/** The attachment names a session's conversation has used; see `listAttachmentNames`. */
export default defineEventHandler(async (event) => {
  return { names: await listAttachmentNames(getRouterParam(event, 'id')!) }
})
