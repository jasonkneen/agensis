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
    />
  );
}
