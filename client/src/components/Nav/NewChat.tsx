import { TooltipAnchor, Button, NewChatIcon } from '@librechat/client';
import { useNavigate } from 'react-router-dom';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export default function NewChat({ className }: { className?: string }) {
  const localize = useLocalize();
  const navigate = useNavigate();

  const clickHandler: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
      window.open('/terminal/new', '_blank');
      return;
    }
    navigate('/terminal/new');
  };

  return (
    <TooltipAnchor
      description={localize('com_ui_new_chat')}
      render={
        <Button
          size="icon"
          variant="outline"
          data-testid="new-chat-button"
          aria-label={localize('com_ui_new_chat')}
          className={cn(
            'size-9 rounded-xl bg-presentation duration-0 hover:bg-surface-active-alt max-md:hidden',
            className,
          )}
          onClick={clickHandler}
        >
          <NewChatIcon />
        </Button>
      }
    />
  );
}
