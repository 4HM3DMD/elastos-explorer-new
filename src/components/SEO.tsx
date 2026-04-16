import { Helmet } from 'react-helmet-async';
import { SITE_NAME, SITE_URL, DEFAULT_DESCRIPTION, DEFAULT_OG_IMAGE } from '../utils/seo';

interface SEOProps {
  title: string;
  description?: string;
  path: string;
  type?: string;
  noindex?: boolean;
}

const SEO = ({ title, description = DEFAULT_DESCRIPTION, path, type = 'website', noindex = false }: SEOProps) => {
  const fullTitle = title === SITE_NAME ? title : `${title} - ${SITE_NAME}`;
  const canonicalUrl = `${SITE_URL}${path}`;
  const imageUrl = `${SITE_URL}${DEFAULT_OG_IMAGE}`;

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonicalUrl} />

      {noindex && <meta name="robots" content="noindex, nofollow" />}

      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:image" content={imageUrl} />
      <meta property="og:site_name" content={SITE_NAME} />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={imageUrl} />
    </Helmet>
  );
};

export default SEO;
