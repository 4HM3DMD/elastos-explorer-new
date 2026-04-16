import { useState, useEffect } from 'react';
import { getAvatarColor, getAvatarInitials, getNodeLogoUrl, isLogoMapReady } from '../utils/nodeAvatar';

interface NodeAvatarProps {
  ownerPubKey: string;
  nickname: string;
  size?: number;
}

const NodeAvatar = ({ ownerPubKey, nickname, size = 32 }: NodeAvatarProps) => {
  const [imgError, setImgError] = useState(false);
  const [ready, setReady] = useState(isLogoMapReady);

  useEffect(() => {
    if (ready) return;
    const id = setInterval(() => {
      if (isLogoMapReady()) {
        setReady(true);
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [ready]);

  const logoUrl = ready ? getNodeLogoUrl(ownerPubKey, nickname) : null;
  const color = getAvatarColor(ownerPubKey || nickname);
  const initials = getAvatarInitials(nickname);
  const fontSize = Math.max(10, Math.round(size * 0.38));

  if (logoUrl && !imgError) {
    return (
      <img
        src={logoUrl}
        alt={nickname}
        width={size}
        height={size}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
        onError={() => setImgError(true)}
      />
    );
  }

  return (
    <div
      className="rounded-full shrink-0 flex items-center justify-center font-bold text-white select-none"
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        fontSize,
        lineHeight: 1,
      }}
      title={nickname}
    >
      {initials}
    </div>
  );
};

export default NodeAvatar;
