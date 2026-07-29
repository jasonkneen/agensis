// Scratch harness — NOT part of the app. Mounts the Tasks window with fixture
// data inside a box the size of a floating window so the chip and the edit panel
// can be photographed without a login. Delete when done.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { TasksWindowContent } from './src/components/windows/TasksWindowContent';
import { resetAgentWork } from './src/lib/agentWork';
import { viewPreferenceKey } from './src/lib/viewPreferences';
import type { Task } from './src/types';
import './src/index.css';

// #list / #kanban / #gantt[,width] — so one navigate lands the exact shot.
const [hashView, hashWidth] = (location.hash.replace('#', '') || 'list').split(',');
localStorage.setItem(viewPreferenceKey('tasks.view', 'ws')!, hashView);

const NOW = Date.now();
const SESSION = 'sess-coder-dm';

const t = (o: Partial<Task> & { id: string; title: string }): Task => ({
  workspace_id: 'ws', created_by: null, assignee_id: null, parent_id: null,
  description: '', status: 'in_progress', priority: 'normal', due_date: null,
  start_date: null, source_type: 'chat', source_id: SESSION, completed_at: null,
  created_at: new Date(NOW - 3 * 86400000).toISOString(),
  updated_at: new Date(NOW).toISOString(), ...o,
} as Task);

const LONG = "Can't escalate, share or save a thread — no path from a DM to another agent or channel";

const TASKS: Task[] = [
  t({ id: 'a', title: LONG }),
  t({ id: 'b', title: 'Wire the panel', start_date: new Date(NOW).toISOString(), due_date: new Date(NOW + 12 * 86400000).toISOString() }),
  t({ id: 'c', title: 'Abandoned four hours ago', updated_at: new Date(NOW - 4 * 3600000).toISOString() }),
  t({ id: 'd', title: 'Not started yet', status: 'todo' }),
  t({ id: 'e', title: 'Finished thing', status: 'done' }),
];

// A live job in the DM, started now — so 'a' and 'b' correlate, 'c' does not.
resetAgentWork([{ id: 'j1', session_id: SESSION, status: 'running', started_at: new Date(NOW - 74_000).toISOString() }]);

function Harness() {
  const [w, setW] = useState(Number(hashWidth) || 900);
  return (
    <div style={{ padding: 16, background: '#0c0c0c', minHeight: '100vh' }}>
      <div style={{ marginBottom: 8, color: '#888', fontFamily: 'monospace', fontSize: 12 }}>
        window width:
        {[560, 700, 900, 1200].map(v => (
          <button key={v} onClick={() => setW(v)} style={{ margin: '0 4px', padding: '2px 8px' }}>{v}</button>
        ))}
        <span> current: {w}</span>
      </div>
      <div style={{ width: w, height: 640, overflow: 'hidden', border: '1px solid #333', borderRadius: 8 }}>
        <TasksWindowContent
          tasks={TASKS}
          members={[]}
          agents={[]}
          agentConnections={[]}
          currentUserEmail="a@b.c"
          workspaceId="ws"
          onCreateTask={() => {}}
          onUpdateTask={() => {}}
          onToggleStatus={() => {}}
          onDeleteTask={() => {}}
          onUpdateAgent={() => {}}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
