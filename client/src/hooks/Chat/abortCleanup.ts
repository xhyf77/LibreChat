import { Constants, QueryKeys } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import { streamStatusQueryKey, type ActiveJobsResponse } from '~/data-provider';

export function isAbortPlaceholderMessage(message: TMessage): boolean {
  if (message.isCreatedByUser === true) {
    return false;
  }

  if (message.unfinished === true) {
    return true;
  }

  return (
    typeof message.messageId === 'string' &&
    message.messageId.endsWith('_') &&
    message.createdAt == null &&
    message.updatedAt == null &&
    message.error !== true
  );
}

export function removeAbortPlaceholderMessages(messages: TMessage[]): TMessage[] {
  return messages.filter((message) => !isAbortPlaceholderMessage(message));
}

export function cleanupAbortedResumableConversation({
  conversationId,
  queryClient,
  getMessages,
  setMessages,
}: {
  conversationId?: string | null;
  queryClient: QueryClient;
  getMessages: () => TMessage[] | undefined;
  setMessages: (messages: TMessage[]) => void;
}) {
  queryClient.setQueryData<ActiveJobsResponse>([QueryKeys.activeJobs], (old) => ({
    activeJobIds: (old?.activeJobIds ?? []).filter((id) => id !== conversationId),
  }));

  const messages = getMessages();
  const cleanedMessages = messages ? removeAbortPlaceholderMessages(messages) : undefined;

  if (messages && cleanedMessages && cleanedMessages.length !== messages.length) {
    setMessages(cleanedMessages);
    if (conversationId) {
      queryClient.setQueryData<TMessage[]>([QueryKeys.messages, conversationId], cleanedMessages);
    }
  }

  if (conversationId) {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, conversationId] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.conversation, conversationId] });
    queryClient.removeQueries({ queryKey: streamStatusQueryKey(conversationId) });
  }

  queryClient.invalidateQueries({ queryKey: [QueryKeys.allConversations] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, Constants.NEW_CONVO] });
}
