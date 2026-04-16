DELETE FROM address_labels WHERE address IN (
    'XVbCTM7vqM1qHKsABSFH4xKN1qbp7ijpWf',
    'XNQWEZ7aqNyJHvav8j8tNo2ZQypuTsWQk6',
    'XV5cSp1y1PU4xXSQs5oaaLExgHA2xHYjp5',
    'EeKGjcERsZvmRYuJSFbrdvyb8MPzKpL3v6',
    'EJyiZrRDhdUtUpkxoLgKmdk8JxKoi1tvHG',
    'EHpQRE4K4e2UhD55ingFc7TETuve13aWbZ',
    'EKk4HeHnLvMpxFiSbjVizcrCB1nVt39Bwe',
    'ETsfuQEcNJbmeT5iPXJxJLc7CtipgaEWZQ',
    'EfpBYgTZxsrS3qtAApMTuSwW1M2N5ieH7k',
    'Eeguj3LmsTnTSyFuvM8DXLmjYNBqa6XK4c',
    'EMWsru8XhpQxJ7CvDzgAea1WroJqskPmqd',
    'EVXNSmx1KzT6Pxzcup3QGh1vCKZckz8XDD',
    'EbEQ1o4fkbqSg5Q4mR1SwHFWTR4WYFUz8P',
    'EfZ6oNo4oKgefbuX3t2dVrH9ME2mR4ZZka',
    'EMRKTXN183vwcGbCetvKuUPHMyQScRjx6F',
    'ETAXSN3kc3N3npEeUzMn4bipwUS3ejooiy',
    'EdaNsdRChz1pmwHRvSCcTvGhZKaEuimToL',
    'EQ34WaW2RmpZhqSUs4DEmVR1RB3zMiJEWe',
    'EPEzY8RqLoHiKB5sXsRLNmMcE6ESqvY6Zq',
    'EexDsiXag2rH4f7VTPNziYdGJdcxCnvGW6',
    'EJERhHYJHx3w87TZ6jVbF5vtF1JQ3yMDPh',
    'EMzsK7X3MhwG5WeCJFCqBwPtgMtJpBeFKL',
    'Eb1Vbp9KNJxNjNRWADjXYyL3pRRHvRdpuV',
    'ER6iCws5hqmVoSeVugnWLNo28rv4iMVy17'
);

UPDATE address_labels SET label = 'Foundation', category = 'foundation' WHERE address = '8VYXVxKKSAxkmRrfmGpQR2Kc66XhG6m3ta';
UPDATE address_labels SET label = 'DAO Treasury (CR Assets)', category = 'dao' WHERE address = 'CRASSETSXXXXXXXXXXXXXXXXXXXX2qDX5J';
UPDATE address_labels SET label = 'DAO Expenses', category = 'dao' WHERE address = 'CREXPENSESXXXXXXXXXXXXXXXXXX4UdT6b';
UPDATE address_labels SET label = 'BPoS Stake Pool', category = 'system' WHERE address = 'STAKEPooLXXXXXXXXXXXXXXXXXXXpP1PQ2';
UPDATE address_labels SET label = 'BPoS Reward Accumulation', category = 'system' WHERE address = 'STAKEREWARDXXXXXXXXXXXXXXXXXFD5SHU';
