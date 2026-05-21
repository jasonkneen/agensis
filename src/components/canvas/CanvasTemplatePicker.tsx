import { useEffect, useCallback } from 'react';
import { X, LayoutTemplate } from 'lucide-react';
import type { CanvasTemplate } from '../../lib/canvasTemplates';
import { CANVAS_TEMPLATES } from '../../lib/canvasTemplates';

interface CanvasTemplatePickerProps {
  open: boolean;
  onClose: () => void;
  onApply: (template: CanvasTemplate) => void;
}

const CanvasTemplatePicker = ({ open, onClose, onApply }: CanvasTemplatePickerProps) => {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [open, handleKeyDown]);

  if (!open) return null;

  const handleApply = (template: CanvasTemplate) => {
    onApply(template);
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.6)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 640,
          margin: '0 16px',
          backgroundColor: 'var(--canvas-elevated)',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-xl)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <LayoutTemplate
              size={20}
              style={{ color: 'var(--accent)', flexShrink: 0 }}
            />
            <span
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              Start from a template
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'transparent',
              color: 'var(--text-muted)',
              cursor: 'pointer',
            }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Template grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 12,
            padding: 20,
            maxHeight: 420,
            overflowY: 'auto',
          }}
        >
          {CANVAS_TEMPLATES.map((template) => (
            <div
              key={template.id}
              onClick={() => handleApply(template)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: 16,
                borderRadius: 'var(--radius-md, 8px)',
                border: '1px solid var(--border-subtle)',
                backgroundColor: 'var(--canvas-raised)',
                cursor: 'pointer',
                transition: 'border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease',
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = 'var(--accent)';
                el.style.boxShadow = '0 0 0 1px var(--accent)';
                el.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = 'var(--border-subtle)';
                el.style.boxShadow = 'none';
                el.style.transform = 'translateY(0)';
              }}
            >
              <span style={{ fontSize: 28, lineHeight: 1 }}>{template.icon}</span>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                {template.name}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  lineHeight: 1.4,
                }}
              >
                {template.description}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  marginTop: 'auto',
                  paddingTop: 4,
                }}
              >
                {template.objects.length} objects
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 20px',
            borderTop: '1px solid var(--border-subtle)',
            fontSize: 11,
            color: 'var(--text-muted)',
          }}
        >
          <span>Click a template to add it to your canvas</span>
          <kbd
            style={{
              padding: '2px 6px',
              fontSize: 11,
              fontFamily: 'inherit',
              backgroundColor: 'var(--canvas-raised)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            ESC
          </kbd>
        </div>
      </div>
    </div>
  );
};

export default CanvasTemplatePicker;
