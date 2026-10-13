import { NativeSelectOptGroup, NativeSelectOption } from '@agensis/ui/components/native-select';
import { agentHandle } from '../../lib/agentAccent';
import type { WorkspaceAgent } from '../../types';
import type { WorkspaceMember } from '../../hooks/useSharing';

// Assignee options: people AND agents. Assigning an agent dispatches the task to
// it — that's the point of the picker, so agents can't be missing from it.
// Disabled agents are left out: they can't run.
export function AssigneeOptions({ members, agents }: { members: WorkspaceMember[]; agents: WorkspaceAgent[] }) {
  const activeAgents = agents.filter(agent => agent.enabled !== false);
  return (
    <>
      <NativeSelectOption value="">Unassigned</NativeSelectOption>
      {members.length > 0 && (
        <NativeSelectOptGroup label="People">
          {members.map(member => (
            <NativeSelectOption key={member.user_id} value={member.user_id}>
              {member.email?.split('@')[0] || 'Member'}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      )}
      {activeAgents.length > 0 && (
        <NativeSelectOptGroup label="Agents">
          {activeAgents.map(agent => (
            <NativeSelectOption key={agent.id} value={agent.id}>
              @{agentHandle(agent)}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      )}
    </>
  );
}
