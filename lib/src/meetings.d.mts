export interface MeetingPosition {
  agendaItem?: string;
  employeeId?: string;
  position?: string;
  evidenceIds?: string[];
  turnType?: string;
  risks?: string[];
}

export interface MeetingMessage {
  kind?: string;
  type?: string;
  delegation_goal?: string | null;
  delegationGoal?: string | null;
  content?: string;
  body?: string;
  from_name?: string | null;
  to_name?: string | null;
  from_employee_id?: string | null;
  to_employee_id?: string | null;
  evidence_ids?: string[];
}

export function isActiveMeetingAssignee(employee: unknown): boolean;
export function buildMeetingParticipantContext(input?: Record<string, unknown>): Record<string, unknown>;
export function buildMeetingMemoryBody(input?: {
  agenda?: unknown[];
  positions?: MeetingPosition[];
  decisions?: unknown[];
  actions?: Array<{ title?: unknown }>;
  messages?: MeetingMessage[];
}): string;
