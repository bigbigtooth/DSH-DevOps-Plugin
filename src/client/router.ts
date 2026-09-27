/**
 * In-memory view stack (IMPROVE §3.1): list ⇄ detail navigation without a
 * router dependency. Tab choice lives inside each view so returning to a
 * detail page keeps the last active tab.
 */

export type ServerDetailTab = 'hardware' | 'processes'
export type ProjectDetailTab = 'services' | 'logs' | 'deploy'

export type View =
  | { kind: 'servers' }
  | { kind: 'server'; serverId: string; serverAlias?: string; tab: ServerDetailTab }
  | { kind: 'projects' }
  | { kind: 'project'; projectId: string; projectAlias?: string; tab: ProjectDetailTab }

export const ROOT_VIEW: View = { kind: 'servers' }

/** Breadcrumb label for a view (root views render their tab title instead). */
export function viewTitle(view: View): string {
  if (view.kind === 'server') return view.serverAlias ?? '服务器详情'
  if (view.kind === 'project') return view.projectAlias ?? '项目详情'
  return view.kind === 'servers' ? '服务器' : '项目'
}

export function isDetail(view: View): boolean {
  return view.kind === 'server' || view.kind === 'project'
}
