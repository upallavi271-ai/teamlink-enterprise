import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { publishingService } from '@/services/social/publishing.service';
import { useOrgStore } from '@/stores/orgStore';
import type { CreateSocialPostInput } from '@/services/social/publishing.types';

const POSTS = 'social-publish-posts';
const PROVIDERS = 'social-publish-providers';
const FB = 'facebook-connection';

export function usePublishProviders() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  return useQuery({ queryKey: [PROVIDERS, orgId], queryFn: () => publishingService.providers(), enabled: !!orgId });
}

export function usePublishPosts() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  return useQuery({
    queryKey: [POSTS, orgId],
    queryFn: () => publishingService.listPosts(20, 0),
    enabled: !!orgId,
    // Poll while any destination is still in flight so status resolves live.
    refetchInterval: (q) => {
      const inFlight = q.state.data?.items.some((p) =>
        p.destinations.some((d) => d.status === 'QUEUED' || d.status === 'PROCESSING' || d.status === 'PENDING'),
      );
      return inFlight ? 4000 : false;
    },
  });
}

export function useFacebookConnection() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  return useQuery({ queryKey: [FB, orgId], queryFn: () => publishingService.facebookStatus(), enabled: !!orgId });
}

export function useContentStudioActions() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const qc = useQueryClient();
  const invalidatePosts = () => qc.invalidateQueries({ queryKey: [POSTS, orgId] });
  const invalidateFb = () => qc.invalidateQueries({ queryKey: [FB, orgId] });

  return {
    createPost: useMutation({
      mutationFn: (input: CreateSocialPostInput) => publishingService.createPost(input),
      onSuccess: invalidatePosts,
    }),
    cancelDestination: useMutation({
      mutationFn: ({ postId, destId }: { postId: string; destId: string }) => publishingService.cancelDestination(postId, destId),
      onSuccess: invalidatePosts,
    }),
    retryDestination: useMutation({
      mutationFn: ({ postId, destId }: { postId: string; destId: string }) => publishingService.retryDestination(postId, destId),
      onSuccess: invalidatePosts,
    }),
    connectFacebook: useMutation({
      mutationFn: () => publishingService.connectFacebook(orgId),
    }),
    selectPage: useMutation({
      mutationFn: (pageId: string) => publishingService.selectFacebookPage(pageId),
      onSuccess: invalidateFb,
    }),
  };
}
