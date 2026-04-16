# Elastos Main Chain Explorer

A modern, responsive frontend for the Elastos (ELA) blockchain explorer built with React, TypeScript, and Tailwind CSS.

## Features

- 🔍 **Real-time Search** - Search blocks, transactions, and addresses
- 📊 **Block Explorer** - Browse latest blocks with detailed information
- 💰 **Transaction Details** - View comprehensive transaction data including UTXO inputs/outputs
- 🏠 **Address Analytics** - Check address balances and transaction history
- 📱 **Responsive Design** - Works seamlessly on desktop and mobile devices
- ⚡ **Fast Performance** - Built with Vite for optimal development and build performance

## Tech Stack

- **React 18** - Modern React with hooks and functional components
- **TypeScript** - Type-safe development
- **Vite** - Fast build tool and development server
- **Tailwind CSS** - Utility-first CSS framework
- **React Router** - Client-side routing
- **Axios** - HTTP client for API requests
- **Lucide React** - Beautiful icons
- **date-fns** - Date formatting utilities

## Getting Started

### Prerequisites

- Node.js 16+ 
- pnpm (recommended) or npm

### Installation

1. Navigate to the frontend directory:
```bash
cd frontend
```

2. Install dependencies:
```bash
pnpm install
# or
npm install
```

3. Start the development server:
```bash
pnpm dev
# or
npm run dev
```

4. Open your browser and visit `http://localhost:3000`

### Backend Connection

The frontend is configured to proxy API requests to the backend server running on `http://localhost:3001`. Make sure your backend server is running before starting the frontend.

## Available Scripts

- `pnpm dev` - Start development server
- `pnpm build` - Build for production
- `pnpm preview` - Preview production build
- `pnpm lint` - Run ESLint

## Project Structure

```
src/
├── components/          # Reusable UI components
│   ├── Header.tsx      # Navigation header
│   ├── Footer.tsx      # Page footer
│   ├── Layout.tsx      # Main layout wrapper
│   └── SearchBar.tsx   # Search functionality
├── pages/              # Page components
│   ├── Home.tsx        # Homepage with latest blocks
│   ├── BlockDetails.tsx    # Block information page
│   ├── TransactionDetails.tsx  # Transaction details page
│   ├── AddressDetails.tsx      # Address information page
│   └── Search.tsx      # Advanced search page
├── services/           # API and external services
│   └── api.ts         # Blockchain API client
├── types/             # TypeScript type definitions
│   └── blockchain.ts  # Blockchain data types
├── App.tsx            # Main app component with routing
├── main.tsx          # React app entry point
└── index.css         # Global styles and Tailwind imports
```

## API Integration

The frontend connects to the backend API with the following endpoints:

- `GET /api/blocks/latest?limit=10` - Get latest blocks
- `GET /api/block/:heightOrHash` - Get block by height or hash
- `GET /api/tx/:txid` - Get transaction details
- `GET /api/address/:address` - Get address information

## Styling

This project uses Tailwind CSS for styling with a custom color palette:

- **Primary Colors**: Blue theme (`primary-50` to `primary-900`)
- **Component Classes**: Pre-defined classes for cards, buttons, etc.
- **Responsive Design**: Mobile-first approach with responsive breakpoints

## Search Functionality

The search bar supports multiple input types:

- **Block Height**: Numeric values (e.g., `123456`)
- **Block Hash**: 64-character hexadecimal strings
- **Transaction Hash**: 64-character hexadecimal strings  
- **Address**: 25-34 character alphanumeric strings

## Contributing

1. Follow the existing code style and TypeScript patterns
2. Use functional components with hooks
3. Maintain responsive design principles
4. Add proper error handling for API calls
5. Include loading states for better UX

## License

This project is part of the Elastos Main Chain Explorer and follows the same licensing terms.
