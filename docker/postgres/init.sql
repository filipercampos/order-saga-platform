-- One database and one login role per service. No role can connect to another
-- service's database, so "no shared tables" is enforced, not just a convention.
-- Local development passwords only; in AWS each role's secret lives in Secrets Manager.
CREATE ROLE order_svc LOGIN PASSWORD 'order_svc';
CREATE ROLE inventory_svc LOGIN PASSWORD 'inventory_svc';
CREATE ROLE payment_svc LOGIN PASSWORD 'payment_svc';
CREATE ROLE notification_svc LOGIN PASSWORD 'notification_svc';

CREATE DATABASE orders OWNER order_svc;
CREATE DATABASE inventory OWNER inventory_svc;
CREATE DATABASE payments OWNER payment_svc;
CREATE DATABASE notifications OWNER notification_svc;

REVOKE CONNECT ON DATABASE orders, inventory, payments, notifications FROM PUBLIC;
GRANT CONNECT ON DATABASE orders TO order_svc;
GRANT CONNECT ON DATABASE inventory TO inventory_svc;
GRANT CONNECT ON DATABASE payments TO payment_svc;
GRANT CONNECT ON DATABASE notifications TO notification_svc;
