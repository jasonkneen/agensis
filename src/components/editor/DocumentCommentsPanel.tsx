import { DocumentComments } from './DocumentComments';
import { useDocumentComments } from '../../hooks/useDocumentComments';

interface DocumentCommentsPanelProps {
  documentId: string;
  workspaceId: string;
  userId?: string;
  currentUserEmail: string;
  pendingAnchor?: string;
  onAnchorConsumed?: () => void;
  onClose?: () => void;
  onCommentCreated?: (docTitle?: string) => void;
  documentTitle?: string;
  /**
   * Agent id -> name, so a comment an AGENT wrote carries its byline. Agents
   * reply through the reply_to_comment MCP tool, and a reply rendered as
   * "Teammate" would be the panel claiming a person said it.
   */
  agentNames?: Record<string, string>;
}

export function DocumentCommentsPanel({
  documentId,
  workspaceId,
  userId,
  currentUserEmail,
  pendingAnchor,
  onAnchorConsumed,
  onClose,
  onCommentCreated,
  documentTitle,
  agentNames,
}: DocumentCommentsPanelProps) {
  const {
    comments,
    topLevel,
    replyMap,
    createComment,
    resolveComment,
    deleteComment,
  } = useDocumentComments(documentId, workspaceId, userId);

  return (
    <DocumentComments
      comments={comments}
      topLevel={topLevel}
      replyMap={replyMap}
      currentUserId={userId}
      currentUserEmail={currentUserEmail}
      pendingAnchor={pendingAnchor}
      onAnchorConsumed={onAnchorConsumed}
      onCreate={async (input) => {
        await createComment(input);
        onCommentCreated?.(documentTitle);
      }}
      onResolve={resolveComment}
      onDelete={deleteComment}
      onClose={onClose}
      agentNames={agentNames}
    />
  );
}
