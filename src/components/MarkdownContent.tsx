import { useMemo, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';
import { cn } from '../lib/cn';

const IMAGE_EXT = /\.(jpe?g|png|gif|svg|webp|bmp)$/i;
const HTML_TAG_PATTERN = /<\/?(?:p|div|span|a|ul|ol|li|h[1-6]|strong|em|br|img|table|tr|td|th|thead|tbody)\b/i;

interface MarkdownContentProps {
  content: string;
  className?: string;
  draftHash?: string;
}

function rewriteImagePaths(md: string, draftHash?: string): string {
  if (!draftHash) return md;

  return md
    .replace(
      /\[([^\]]*)\]\(\.\/(image\/[^)]+)\)/g,
      (_match, alt, path) => {
        const filename = path.replace(/^image\//, '');
        return `![${alt}](/api/v1/cr/proposal-image/${draftHash}/${filename})`;
      }
    )
    .replace(
      /!\[([^\]]*)\]\(\.\/(image\/[^)]+)\)/g,
      (_match, alt, path) => {
        const filename = path.replace(/^image\//, '');
        return `![${alt}](/api/v1/cr/proposal-image/${draftHash}/${filename})`;
      }
    );
}

/**
 * For mixed content (markdown images + HTML), convert markdown image syntax
 * to HTML <img> tags so the entire content can be rendered as sanitized HTML.
 */
function mdImagesToHtml(text: string): string {
  return text.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy" />`
  );
}

function MarkdownLink({ href, children, ...rest }: ComponentPropsWithoutRef<'a'>) {
  if (href && IMAGE_EXT.test(href)) {
    const alt = typeof children === 'string' ? children : 'image';
    return <img src={href} alt={alt} loading="lazy" className="max-w-full rounded-lg my-4" />;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'hr', 'span',
    'div', 'sup', 'sub', 'dl', 'dt', 'dd',
  ],
  ALLOWED_ATTR: [
    'href', 'target', 'rel', 'src', 'alt', 'title', 'class',
    'width', 'height', 'colspan', 'rowspan', 'loading',
  ],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target'],
};

function isHtmlContent(text: string): boolean {
  return HTML_TAG_PATTERN.test(text);
}

const MarkdownContent = ({ content, className, draftHash }: MarkdownContentProps) => {
  if (!content || content.trim() === '') return null;

  const processed = useMemo(() => rewriteImagePaths(content, draftHash), [content, draftHash]);
  const html = isHtmlContent(processed);

  if (html) {
    const withImages = mdImagesToHtml(processed);
    const clean = DOMPurify.sanitize(withImages, PURIFY_CONFIG);
    return (
      <div
        className={cn('markdown-content overflow-hidden', className)}
        dangerouslySetInnerHTML={{ __html: clean }}
      />
    );
  }

  return (
    <div className={cn('markdown-content overflow-hidden', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: MarkdownLink }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownContent;
