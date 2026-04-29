module.exports = {
  development: {
    client: 'pg',
    connection: {
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      password: 'Rohan@123',
     database: 'tally_dashboard_test'
    },
    migrations: {
      directory: './migrations'
    }
  }
};