import { MongoClient } from 'mongodb';

export const MONGO_DB = Symbol('MONGO_DB');
export const MONGO_CLIENT = Symbol('MONGO_CLIENT');

/**
 * DocumentDB-safe client settings: DocumentDB does not support retryable writes, so they
 * are disabled here instead of relying on the connection string. In AWS the URL adds
 * tls=true&tlsCAFile=global-bundle.pem&replicaSet=rs0&readPreference=secondaryPreferred.
 */
export function createMongoClient(url: string): MongoClient {
  return new MongoClient(url, {
    retryWrites: false,
    appName: 'order-service',
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 20,
  });
}
