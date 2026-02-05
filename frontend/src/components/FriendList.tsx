/**
 * ==============================================================================
 * FRIEND LIST COMPONENT
 * ==============================================================================
 *
 * Displays the user's friends with real-time online status.
 * PlayStation-inspired design with presence indicators and game info.
 *
 * FEATURES:
 * - Online/offline status indicators
 * - Currently playing game display
 * - Quick actions (message, invite to game)
 * - Search and filter
 *
 * PATTERN: Container/Presentational
 * - FriendList handles data fetching
 * - FriendCard handles presentation
 *
 * INTERVIEW TIP:
 * "The friend list demonstrates real-time subscriptions, optimistic updates,
 * and efficient re-rendering with React.memo for individual friend items."
 * ==============================================================================
 */

import React, { useState, useMemo, useCallback } from 'react';
import { gql, useQuery } from '@apollo/client';
import { useFriendPresence, usePresence } from '../hooks/usePresence';
import styled from 'styled-components';

// ============================================================================
// GRAPHQL
// ============================================================================

const GET_FRIENDS = gql`
  query GetFriends {
    me {
      friends {
        id
        gamertag
        avatar
        level
        status
        currentGame
      }
    }
  }
`;

// ============================================================================
// STYLED COMPONENTS
// ============================================================================

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #16213e;
  border-radius: 12px;
  overflow: hidden;
`;

const Header = styled.div`
  padding: 16px 20px;
  background: #1a1a2e;
  border-bottom: 1px solid #2a2a4a;
`;

const Title = styled.h2`
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  display: flex;
  align-items: center;
  gap: 8px;
`;

const OnlineCount = styled.span`
  font-size: 14px;
  font-weight: 400;
  color: #00d26a;
`;

const SearchInput = styled.input`
  width: 100%;
  margin-top: 12px;
  padding: 10px 14px;
  background: #2a2a4a;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #ffffff;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;

  &::placeholder {
    color: #888;
  }

  &:focus {
    border-color: #0070d1;
  }
`;

const FilterTabs = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 12px;
`;

const FilterTab = styled.button<{ $active: boolean }>`
  padding: 6px 12px;
  background: ${(props) => (props.$active ? '#0070d1' : 'transparent')};
  border: 1px solid ${(props) => (props.$active ? '#0070d1' : '#3a3a5a')};
  border-radius: 16px;
  color: #ffffff;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    border-color: #0070d1;
  }
`;

const FriendsList = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 8px;
`;

const FriendCardContainer = styled.div<{ $isOnline: boolean }>`
  display: flex;
  align-items: center;
  padding: 12px;
  margin-bottom: 4px;
  background: ${(props) => (props.$isOnline ? '#1a2a4e' : '#1a1a2e')};
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;

  &:hover {
    background: #2a3a5e;
  }
`;

const Avatar = styled.div<{ $isOnline: boolean }>`
  position: relative;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #2a2a4a;
  border-radius: 50%;
  font-size: 24px;

  &::after {
    content: '';
    position: absolute;
    bottom: 2px;
    right: 2px;
    width: 12px;
    height: 12px;
    background: ${(props) => (props.$isOnline ? '#00d26a' : '#666')};
    border: 2px solid #16213e;
    border-radius: 50%;
  }
`;

const FriendInfo = styled.div`
  flex: 1;
  margin-left: 12px;
`;

const Gamertag = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
`;

const StatusText = styled.div<{ $isOnline: boolean }>`
  font-size: 12px;
  color: ${(props) => (props.$isOnline ? '#00d26a' : '#888')};
  margin-top: 2px;
`;

const CurrentGame = styled.div`
  font-size: 12px;
  color: #0070d1;
  margin-top: 2px;
`;

const Level = styled.div`
  font-size: 12px;
  color: #888;
  background: #2a2a4a;
  padding: 4px 8px;
  border-radius: 4px;
`;

// ============================================================================
// FRIEND CARD COMPONENT
// ============================================================================

interface Friend {
  id: string;
  gamertag: string;
  avatar: string;
  level: number;
  status: string;
  currentGame: string | null;
}

interface FriendCardProps {
  friend: Friend;
  onClick: (friend: Friend) => void;
}

/**
 * Individual friend card with presence info.
 * Memoized to prevent unnecessary re-renders.
 */
const FriendCard = React.memo(function FriendCard({
  friend,
  onClick,
}: FriendCardProps): JSX.Element {
  const presence = useFriendPresence(friend.id);

  // Use presence data if available, fall back to query data
  const status = presence?.status || friend.status;
  const currentGame = presence?.currentGame || friend.currentGame;
  const isOnline = status === 'online' || status === 'away' || status === 'busy';

  const getStatusText = (): string => {
    switch (status) {
      case 'online':
        return 'Online';
      case 'away':
        return 'Away';
      case 'busy':
        return 'Do Not Disturb';
      default:
        return 'Offline';
    }
  };

  return (
    <FriendCardContainer $isOnline={isOnline} onClick={() => onClick(friend)}>
      <Avatar $isOnline={isOnline}>{friend.avatar}</Avatar>
      <FriendInfo>
        <Gamertag>{friend.gamertag}</Gamertag>
        <StatusText $isOnline={isOnline}>{getStatusText()}</StatusText>
        {currentGame && <CurrentGame>Playing {currentGame}</CurrentGame>}
      </FriendInfo>
      <Level>Lv. {friend.level}</Level>
    </FriendCardContainer>
  );
});

// ============================================================================
// FRIEND LIST COMPONENT
// ============================================================================

type FilterType = 'all' | 'online' | 'playing';

interface FriendListProps {
  onFriendClick?: (friend: Friend) => void;
}

export function FriendList({ onFriendClick }: FriendListProps): JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const { onlineFriendsCount } = usePresence();

  const { data, loading, error } = useQuery(GET_FRIENDS);

  const friends: Friend[] = data?.me?.friends || [];

  // ---------------------------------------------------------------------------
  // FILTERING AND SORTING
  // ---------------------------------------------------------------------------

  const filteredFriends = useMemo(() => {
    let result = friends;

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter((f) => f.gamertag.toLowerCase().includes(query));
    }

    // Apply status filter
    if (filter === 'online') {
      result = result.filter(
        (f) => f.status === 'online' || f.status === 'away' || f.status === 'busy'
      );
    } else if (filter === 'playing') {
      result = result.filter((f) => f.currentGame !== null);
    }

    // Sort: online first, then alphabetically
    result = [...result].sort((a, b) => {
      const aOnline = a.status === 'online' || a.status === 'away' || a.status === 'busy';
      const bOnline = b.status === 'online' || b.status === 'away' || b.status === 'busy';

      if (aOnline !== bOnline) {
        return aOnline ? -1 : 1;
      }

      return a.gamertag.localeCompare(b.gamertag);
    });

    return result;
  }, [friends, searchQuery, filter]);

  // ---------------------------------------------------------------------------
  // HANDLERS
  // ---------------------------------------------------------------------------

  const handleFriendClick = useCallback(
    (friend: Friend) => {
      onFriendClick?.(friend);
    },
    [onFriendClick]
  );

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <Container>
        <Header>
          <Title>Friends</Title>
        </Header>
        <FriendsList>
          <div style={{ padding: 20, color: '#888', textAlign: 'center' }}>
            Loading friends...
          </div>
        </FriendsList>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <Header>
          <Title>Friends</Title>
        </Header>
        <FriendsList>
          <div style={{ padding: 20, color: '#ff4444', textAlign: 'center' }}>
            Error loading friends
          </div>
        </FriendsList>
      </Container>
    );
  }

  return (
    <Container>
      <Header>
        <Title>
          Friends
          <OnlineCount>{onlineFriendsCount} Online</OnlineCount>
        </Title>
        <SearchInput
          placeholder="Search friends..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <FilterTabs>
          <FilterTab $active={filter === 'all'} onClick={() => setFilter('all')}>
            All ({friends.length})
          </FilterTab>
          <FilterTab $active={filter === 'online'} onClick={() => setFilter('online')}>
            Online
          </FilterTab>
          <FilterTab $active={filter === 'playing'} onClick={() => setFilter('playing')}>
            In Game
          </FilterTab>
        </FilterTabs>
      </Header>
      <FriendsList>
        {filteredFriends.length === 0 ? (
          <div style={{ padding: 20, color: '#888', textAlign: 'center' }}>
            {searchQuery ? 'No friends found' : 'No friends yet'}
          </div>
        ) : (
          filteredFriends.map((friend) => (
            <FriendCard
              key={friend.id}
              friend={friend}
              onClick={handleFriendClick}
            />
          ))
        )}
      </FriendsList>
    </Container>
  );
}

export default FriendList;
