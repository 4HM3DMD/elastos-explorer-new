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
// Validate image URLs BEFORE inserting them into raw HTML so DOMPurify
// has less work to do and we don't rely on it as the only line of
// defense against `javascript:` / `data:` href injection. Allows
// http(s):// (absolute), //host (protocol-relative), /path (root),
// and bare relative paths. Strips quotes / angle brackets that could
// break out of the attribute. Returns empty string on rejection so
// the resulting <img> renders nothing rather than a broken link.
function safeImageSrc(src: string): string {
  const s = src.trim();
  if (!s) return '';
  // Reject anything that opens an attribute escape, contains a quote,
  // or looks like a non-http(s) protocol scheme.
  if (/["'<>\s]/.test(s)) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    // Has a scheme — only http: and https: are acceptable.
    if (!/^https?:/i.test(s)) return '';
  }
  return s;
}

function mdImagesToHtml(text: string): string {
  return text.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, alt, src) => {
      const safeSrc = safeImageSrc(src);
      // Strip quotes from alt too — same attribute-escape concern.
      const safeAlt = String(alt).replace(/["'<>]/g, '');
      if (!safeSrc) return ''; // drop the image entirely if URL fails the gate
      return `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy" />`;
    }
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

// Defense-in-depth for the HTML-content path: every <a target="_blank">
// gets `rel="noopener noreferrer"` injected. Modern browsers already
// imply noopener for target=_blank since 2020 (Chrome 88, Firefox 79,
// Safari 12.1), so this is belt-and-braces — but proposal markdown is
// untrusted user content and the markdown-only path (MarkdownLink
// component) hardcodes the same rel, so HTML should match.
//
// Hook is a module-level setup so it only registers once. The
// `if (...)` guard prevents double-registration if the module ever
// re-evaluates (HMR, etc.).
let purifyHookRegistered = false;
function ensurePurifyHook() {
  if (purifyHookRegistered) return;
  purifyHookRegistered = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function isHtmlContent(text: string): boolean {
  return HTML_TAG_PATTERN.test(text);
}

const MarkdownContent = ({ content, className, draftHash }: MarkdownContentProps) => {
  if (!content || content.trim() === '') return null;

  const processed = useMemo(() => rewriteImagePaths(content, draftHash), [content, draftHash]);
  const html = isHtmlContent(processed);

  if (html) {
    ensurePurifyHook();
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
