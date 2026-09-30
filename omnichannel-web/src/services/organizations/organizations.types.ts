export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string;
  status: string;
  /** The signed-in user owns this organization. */
  owner: boolean;
  roleLabel: string;
  memberCount: number;
  workspaceCount: number;
  /** Switching to this organization means switching to this workspace. */
  defaultWorkspaceId?: string;
  defaultWorkspaceName?: string;
  joinedAt: string;
}

export interface OrganizationMember {
  userId: string;
  name: string;
  email: string;
  avatarUrl?: string;
  roleKey: string;
  roleName: string;
  workspaceName: string;
  joinedAt: string;
}

export interface PendingInvite {
  id: string;
  email: string;
  roleName: string;
  expiresAt: string;
  invitedAt: string;
}

export interface InvitableRole { key: string; name: string; description?: string }

export interface OrganizationDetail {
  id: string;
  name: string;
  memberCount: number;
  members: OrganizationMember[];
  pendingInvites: PendingInvite[];
  roles: InvitableRole[];
}

export interface CreateOrganizationInput { name: string; workspaceName?: string }
export interface InviteInput { email: string; roleKeys: string[] }

export interface InviteResultView {
  id: string;
  email: string;
  expiresAt: string;
  role: { key: string; name: string };
  workspaceName: string;
  /** Roles ticked but not granted — a membership carries exactly one. */
  ignoredRoles: string[];
  delivery: 'email' | 'demo';
  /** Demo mode only: the invite link token, since no mail is sent. */
  token?: string;
}
