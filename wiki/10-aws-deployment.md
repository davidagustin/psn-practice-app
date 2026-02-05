# AWS Deployment: Production-Ready Infrastructure

## Overview

This document covers the complete AWS deployment architecture for the PSN Practice App, including infrastructure-as-code (Terraform), containerization (ECS Fargate), caching (ElastiCache), event streaming (MSK), load balancing, and observability.

The architecture demonstrates production-grade design patterns used at scale by major tech companies. It's designed to handle millions of concurrent users while maintaining high availability and low latency.

---

## Architecture Diagram

```
                          ┌─────────────────────────┐
                          │    Internet / Users     │
                          └────────────┬────────────┘
                                       │
                          ┌────────────▼────────────┐
                          │  Route 53 (DNS)         │
                          └────────────┬────────────┘
                                       │
         ┌─────────────────────────────┼─────────────────────────────┐
         │                             │                             │
         │                  ┌──────────▼──────────┐                  │
         │                  │   ALB (Multi-AZ)    │                  │
         │                  │  Port 80, 443       │                  │
         │                  └──────────┬──────────┘                  │
         │                             │                             │
    ┌────▼────────┐           ┌────────▼────────┐           ┌────▼────────┐
    │   Public    │           │   Public        │           │   Public    │
    │   Subnet    │           │   Subnet        │           │   Subnet    │
    │   (AZ-a)    │           │   (AZ-b)        │           │   (AZ-c)    │
    │             │           │                 │           │             │
    │   NAT GW    │           │   NAT GW        │           │   NAT GW    │
    └────┬────────┘           └────┬────────┘           └────┬────────┘
         │                         │                         │
    ┌────▼────────────────────────▼─────────────────────────▼────┐
    │                         VPC (10.0.0.0/16)                   │
    │                                                              │
    │  ┌──────────────────────────────────────────────────────┐  │
    │  │              PRIVATE SUBNETS                         │  │
    │  │                                                      │  │
    │  │  ┌─────────────────┐  ┌──────────────────┐          │  │
    │  │  │  ECS Fargate    │  │ ElastiCache      │          │  │
    │  │  │  Tasks          │  │ Redis Cluster    │          │  │
    │  │  │  Port 4000      │  │ Multi-AZ         │          │  │
    │  │  │                 │  │ Failover         │          │  │
    │  │  │ Min: 2 Tasks    │  │                  │          │  │
    │  │  │ Max: 10 Tasks   │  │ Encryption       │          │  │
    │  │  │ (Auto-scale)    │  │ (at-rest/transit)│          │  │
    │  │  └─────────────────┘  └──────────────────┘          │  │
    │  │                                                      │  │
    │  │  ┌──────────────────────────────────────┐           │  │
    │  │  │  MSK (Kafka)                         │           │  │
    │  │  │  3 Brokers (Cluster Mode)            │           │  │
    │  │  │  Topics: user-events, game-events    │           │  │
    │  │  │  TLS Encryption                      │           │  │
    │  │  │  SCRAM Authentication                │           │  │
    │  │  └──────────────────────────────────────┘           │  │
    │  │                                                      │  │
    │  └──────────────────────────────────────────────────────┘  │
    └──────────────────────────────────────────────────────────────┘
         │                         │                         │
         │                         │                         │
    ┌────▼────────┐           ┌────▼────────┐           ┌────▼────────┐
    │   RDS DB    │           │   RDS DB    │           │   RDS DB    │
    │   (Primary) │           │   (Standby) │           │   (Read)    │
    │   (AZ-a)    │           │   (AZ-b)    │           │   (AZ-c)    │
    └─────────────┘           └─────────────┘           └─────────────┘

    ┌────────────────────────────────────────┐
    │      CloudWatch Logs & Metrics         │
    │      - ECS Task Logs                   │
    │      - Redis Performance               │
    │      - Kafka Broker Health             │
    │      - ALB Request Metrics              │
    └────────────────────────────────────────┘
```

---

## 1. VPC Design

### Subnet Layout

The VPC uses a 3-tier architecture across 2 availability zones (or 3 for higher redundancy):

```
VPC CIDR: 10.0.0.0/16

Public Subnets (NAT Gateway hosts):
├─ AZ-a: 10.0.0.0/24   (ALB, NAT Gateway)
├─ AZ-b: 10.0.1.0/24   (ALB, NAT Gateway)
└─ AZ-c: 10.0.2.0/24   (ALB, NAT Gateway)

Private Subnets (Application tier):
├─ AZ-a: 10.0.10.0/24  (ECS, ElastiCache, MSK)
├─ AZ-b: 10.0.11.0/24  (ECS, ElastiCache, MSK)
└─ AZ-c: 10.0.12.0/24  (ECS, ElastiCache, MSK)

Private Subnets (Database tier):
├─ AZ-a: 10.0.20.0/24  (RDS Primary)
├─ AZ-b: 10.0.21.0/24  (RDS Standby/Read)
└─ AZ-c: 10.0.22.0/24  (RDS Read)
```

### Why This Design?

1. **Public Subnets**: Only ALB and NAT Gateways are exposed to the internet
2. **Private Subnets**: ECS tasks, Redis, Kafka have no public IPs
3. **Multi-AZ**: If one AZ fails, traffic flows to remaining AZs
4. **NAT Gateways**: Private subnets can reach internet for software updates (one per AZ for HA)

### Terraform Implementation

```hcl
# VPC
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr        # 10.0.0.0/16
  enable_dns_hostnames = true
  enable_dns_support   = true
}

# Internet Gateway (for public subnets)
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

# Public Subnets (2 AZs)
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true  # Get public IPs
}

# NAT Gateways for private subnet internet access
resource "aws_nat_gateway" "main" {
  count         = 2
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  depends_on    = [aws_internet_gateway.main]
}

# Private Subnets (2 AZs)
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]
}
```

---

## 2. Application Load Balancer (ALB)

### Configuration

The ALB distributes incoming traffic across ECS tasks with health checks and sticky sessions.

```hcl
resource "aws_lb" "main" {
  name               = "psn-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  enable_deletion_protection = false
}

resource "aws_lb_target_group" "app" {
  name        = "psn-tg"
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"  # For ECS Fargate

  health_check {
    enabled             = true
    healthy_threshold   = 2      # Need 2 passing checks
    interval            = 30     # Check every 30 seconds
    matcher             = "200"  # Expect HTTP 200
    path                = "/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 5      # Each check has 5 second timeout
    unhealthy_threshold = 3      # Mark unhealthy after 3 failures
  }

  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400  # Keep session 24 hours
    enabled         = true   # Sticky sessions (same task)
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
```

### Health Check Design

```
Health Check Flow:
├─ ALB sends HTTP GET /health to port 4000
├─ ECS task responds with 200 OK
├─ ALB marks task as HEALTHY
└─ ALB routes traffic to task

If 3 consecutive checks fail:
├─ Task marked UNHEALTHY
├─ ALB stops routing traffic to it
└─ Auto-scaling replaces the task
```

### Production Considerations

- **Enable HTTPS**: Add SSL listener on port 443
- **Sticky Sessions**: Useful for WebSocket connections (same pod per client)
- **Request Logging**: Log to S3 for audit trails
- **WAF**: Use AWS WAF to block DDoS and malicious requests

---

## 3. ECS Fargate: Containerized Services

### What is Fargate?

Fargate is a serverless compute engine for containers. You define task requirements (CPU/memory), AWS provisions the infrastructure, and you pay only for resources used.

### Task Definition

```hcl
resource "aws_ecs_task_definition" "app" {
  family                   = "psn-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"  # Required for Fargate
  cpu                      = "512"     # 0.5 vCPU
  memory                   = "1024"    # 1 GB RAM
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "psn-app"
      image     = "${aws_ecr_repository.app.repository_url}:latest"
      essential = true

      portMappings = [
        {
          containerPort = 4000
          protocol      = "tcp"
        }
      ]

      environment = [
        {
          name  = "NODE_ENV"
          value = "production"
        },
        {
          name  = "REDIS_URL"
          value = "redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
        },
        {
          name  = "KAFKA_BROKERS"
          value = aws_msk_cluster.kafka.bootstrap_brokers_tls
        }
      ]

      # Send logs to CloudWatch
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
          "awslogs-region"        = "us-east-1"
          "awslogs-stream-prefix" = "ecs"
        }
      }

      # Health check (container level)
      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:4000/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60  # Wait 60s after container start
      }
    }
  ])
}
```

### ECS Service

```hcl
resource "aws_ecs_service" "app" {
  name            = "psn-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = 2              # Start with 2 tasks
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false  # Use private IPs
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "psn-app"
    container_port   = 4000
  }

  # Deploy new versions with zero downtime
  deployment_circuit_breaker {
    enable   = true   # Detect bad deployments
    rollback = true   # Rollback automatically
  }

  deployment_controller {
    type = "ECS"  # Use ECS rolling updates
  }
}
```

### CPU/Memory Combinations

AWS Fargate requires specific CPU/memory combinations:

```
CPU        Memory Options
0.25 vCPU  512 MB, 1 GB, 2 GB
0.5 vCPU   1 GB, 2 GB, 3 GB, 4 GB
1 vCPU     2 GB, 3 GB, 4 GB, 5 GB, 6 GB, 7 GB, 8 GB
2 vCPU     4 GB - 16 GB
4 vCPU     8 GB - 30 GB
```

**Recommendation for PSN App**: Start with 512 CPU / 1024 MB, scale up based on load.

---

## 4. Auto-Scaling

### CPU-Based Scaling Policy

```hcl
resource "aws_appautoscaling_target" "ecs" {
  max_capacity       = 10
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "ecs_cpu" {
  name               = "cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70.0      # Scale up when CPU > 70%
    scale_in_cooldown  = 300       # Wait 5 minutes before scaling down
    scale_out_cooldown = 60        # Scale up immediately
  }
}
```

### Scaling Logic

```
Scenario: Traffic surge (500 → 5000 requests/sec)

1. Existing 2 tasks reach 85% CPU
2. Auto-scaling detects CPU > 70%
3. CloudWatch triggers scale-out policy
4. ECS creates new tasks (2 → 3)
5. ALB distributes traffic to 3 tasks
6. CPU drops to 55%
7. New tasks run for 5 minutes
8. CPU remains below 70%, no scale-down yet
9. After 5 minutes cooldown, scale-down triggers
10. ECS terminates extra task (3 → 2)
```

---

## 5. ElastiCache Redis Cluster

### Architecture

ElastiCache Redis provides a managed, multi-AZ Redis cluster with automatic failover.

```hcl
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "psn-redis"
  description          = "PSN App Redis cluster"

  engine           = "redis"
  engine_version   = "7.0"
  node_type        = "cache.t3.medium"
  num_cache_clusters = 2           # Primary + 1 replica

  parameter_group_name = "default.redis7"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [aws_security_group.redis.id]

  # High availability
  automatic_failover_enabled = true
  multi_az_enabled           = true

  # Security
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  # Backups
  snapshot_retention_limit = 7       # Keep 7 days of snapshots
  snapshot_window          = "03:00-05:00"
  maintenance_window       = "sun:05:00-sun:07:00"

  tags = {
    Name = "psn-redis"
  }
}
```

### Cluster Mode

**Disabled (Replication)**:
- Single primary node
- Replicas for read scaling
- All writes go to primary
- Best for <50GB dataset

**Enabled (Sharding)**:
- Multiple primary shards
- Each shard has replicas
- Data automatically sharded
- Horizontal scaling
- Best for >50GB dataset

For the PSN app, we use **replication mode** (single primary):
- User sessions: <50GB at scale
- Redis reads primary/replicas
- Simpler to manage
- Lower cost

### Parameter Groups

```hcl
# Custom parameter group for PSN app
resource "aws_elasticache_parameter_group" "psn" {
  family = "redis7"
  name   = "psn-params"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"  # Evict least-recently-used keys
  }

  parameter {
    name  = "timeout"
    value = "300"  # Close idle connections after 5 minutes
  }

  parameter {
    name  = "tcp-keepalive"
    value = "60"  # Send keepalive every 60 seconds
  }
}
```

### Connection String

```
Primary: psn-redis.xxxxx.ng.0001.use1.cache.amazonaws.com:6379
Replica: psn-redis-ro.xxxxx.ng.0001.use1.cache.amazonaws.com:6379  (read-only endpoint)
```

### Data Structure Examples

```typescript
// User sessions (String)
SET session:abc123 '{"userId":"user1","email":"..."}' EX 86400

// User friends (Set)
SADD user:123:friends 456 789 234

// Friend requests (Sorted Set - ordered by timestamp)
ZADD user:123:friend-requests 1704067200 user456

// User presence (Hash)
HSET user:123:presence online true lastSeen 1704067320

// Message history (List - newest first)
LPUSH room:chat-1:messages "msg content" LPRANGE 0 -1
```

### Production Considerations

- **Read from Replicas**: Use read-only endpoint for cache reads to distribute load
- **Multi-AZ Failover**: If primary fails, replica promoted automatically
- **Backups**: Use snapshots for disaster recovery
- **Monitoring**: Track cache hit ratio, evictions, CPU

---

## 6. MSK (Managed Streaming for Apache Kafka)

### Cluster Configuration

```hcl
resource "aws_msk_cluster" "kafka" {
  cluster_name           = "psn-kafka"
  kafka_version          = "3.4.0"
  number_of_broker_nodes = 3  # 3 brokers for fault tolerance

  broker_node_group_info {
    instance_type   = "kafka.m5.large"
    client_subnets  = aws_subnet.private[*].id
    security_groups = [aws_security_group.kafka.id]

    storage_info {
      ebs_storage_info {
        volume_size = 100  # 100 GB per broker
      }
    }
  }

  # Encryption
  encryption_info {
    encryption_in_transit {
      client_broker = "TLS"  # Encrypt broker-to-client
      in_cluster    = true   # Encrypt broker-to-broker
    }
  }

  # Logging
  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.kafka.name
      }
    }
  }

  tags = {
    Name = "psn-kafka"
  }
}
```

### Topic Creation

```bash
# Connect to MSK broker
export BOOTSTRAP_SERVERS="b-1.kafka.xxxxx.kafka.amazonaws.com:9092,b-2.kafka.xxxxx.kafka.amazonaws.com:9092,b-3.kafka.xxxxx.kafka.amazonaws.com:9092"

# Create user events topic (3 partitions for parallelism)
aws kafka create-topic \
  --cluster-arn arn:aws:kafka:us-east-1:123456789:cluster/psn-kafka/abc123 \
  --topic-name psn.user.events \
  --partitions 3 \
  --replication-factor 2

# Create game events topic
aws kafka create-topic \
  --cluster-arn arn:aws:kafka:us-east-1:123456789:cluster/psn-kafka/abc123 \
  --topic-name psn.game.events \
  --partitions 3 \
  --replication-factor 2
```

### Consumer Groups

```typescript
// JavaScript/Node.js example
import { Kafka } from 'kafkajs';

const kafka = new Kafka({
  clientId: 'psn-app',
  brokers: [
    'b-1.kafka.xxxxx.kafka.amazonaws.com:9092',
    'b-2.kafka.xxxxx.kafka.amazonaws.com:9092',
    'b-3.kafka.xxxxx.kafka.amazonaws.com:9092',
  ],
  ssl: true,  // TLS encryption
  sasl: {
    mechanism: 'scram-sha-512',
    username: process.env.KAFKA_USERNAME,
    password: process.env.KAFKA_PASSWORD,
  },
});

const consumer = kafka.consumer({ groupId: 'psn-user-service' });

await consumer.subscribe({ topic: 'psn.user.events' });
await consumer.run({
  eachMessage: async ({ topic, partition, message }) => {
    const event = JSON.parse(message.value.toString());
    console.log(`Received: ${event.type}`);
    // Process event
  },
});
```

### Topic Configuration

```
Topic: psn.user.events
├─ Partitions: 3 (user1,user2 → partition 0; user3,user4 → partition 1; etc.)
├─ Replication: 2 (data replicated on 2 brokers)
├─ Retention: 7 days
└─ Compaction: disabled

Topic: psn.notifications
├─ Partitions: 5
├─ Replication: 3
├─ Retention: 24 hours
└─ Compaction: enabled (keep latest per key)
```

### Ordering Guarantees

Events with the same key go to the same partition, preserving order:

```
Producer sends: user_id=123
├─ Event 1: user.registered
├─ Event 2: user.profile_updated
└─ Event 3: user.logged_in

All 3 events → Same partition (preserving order)
Consumer reads in order: registered → updated → logged_in
```

---

## 7. Security Groups

### ALB Security Group

```hcl
resource "aws_security_group" "alb" {
  name_prefix = "psn-alb-"
  vpc_id      = aws_vpc.main.id

  # Allow HTTP from internet
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow HTTPS from internet
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow all outbound traffic
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```

### ECS Tasks Security Group

```hcl
resource "aws_security_group" "ecs_tasks" {
  name_prefix = "psn-ecs-"
  vpc_id      = aws_vpc.main.id

  # Allow traffic from ALB
  ingress {
    from_port       = 4000
    to_port         = 4000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Allow all outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```

### ElastiCache Security Group

```hcl
resource "aws_security_group" "redis" {
  name_prefix = "psn-redis-"
  vpc_id      = aws_vpc.main.id

  # Allow Redis from ECS tasks only
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }
}
```

### MSK Security Group

```hcl
resource "aws_security_group" "kafka" {
  name_prefix = "psn-kafka-"
  vpc_id      = aws_vpc.main.id

  # Allow plaintext (internal only)
  ingress {
    from_port       = 9092
    to_port         = 9092
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  # Allow TLS
  ingress {
    from_port       = 9094
    to_port         = 9094
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }
}
```

---

## 8. IAM Roles & Permissions

### ECS Task Execution Role

```hcl
resource "aws_iam_role" "ecs_execution" {
  name = "psn-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

# Attach AWS-managed policy
resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
```

This gives ECS permission to:
- Pull Docker images from ECR
- Write logs to CloudWatch
- Assume the task role

### ECS Task Role

```hcl
resource "aws_iam_role" "ecs_task" {
  name = "psn-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

# Custom policy for application permissions
resource "aws_iam_role_policy" "ecs_task_policy" {
  name = "psn-ecs-task-policy"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
        ]
        Resource = "arn:aws:s3:::psn-app-bucket/*"
      },
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData",
          "xray:PutTraceSegments",
        ]
        Resource = "*"
      }
    ]
  })
}
```

---

## 9. Terraform State Management

### S3 Backend Configuration

```hcl
# In main.tf
terraform {
  backend "s3" {
    bucket         = "psn-terraform-state"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}

# Create S3 bucket for state
resource "aws_s3_bucket" "terraform_state" {
  bucket = "psn-terraform-state"

  tags = {
    Name = "PSN Terraform State"
  }
}

# Enable versioning for rollback
resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Encrypt state files
resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# DynamoDB for state locking
resource "aws_dynamodb_table" "terraform_locks" {
  name           = "terraform-locks"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Name = "Terraform Lock Table"
  }
}
```

### Environment Separation

```
terraform/
├── main.tf                 # Core resources
├── variables.tf            # Variable definitions
├── outputs.tf              # Output values
├── dev.tfvars              # Development environment
├── staging.tfvars          # Staging environment
└── production.tfvars       # Production environment

# Development
terraform plan -var-file=dev.tfvars

# Staging
terraform plan -var-file=staging.tfvars

# Production (requires approval)
terraform plan -var-file=production.tfvars
terraform apply -var-file=production.tfvars
```

### Variables

```hcl
variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "container_cpu" {
  type    = number
  default = 512    # Start small
}

variable "container_memory" {
  type    = number
  default = 1024   # 1 GB
}

variable "desired_count" {
  type    = number
  default = 2      # Min instances
}

variable "redis_node_type" {
  type    = string
  default = "cache.t3.medium"
}

variable "kafka_broker_count" {
  type    = number
  default = 3
}
```

### Outputs

```hcl
output "alb_dns_name" {
  description = "DNS name of load balancer"
  value       = aws_lb.main.dns_name
}

output "redis_endpoint" {
  description = "Redis primary endpoint"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "kafka_bootstrap_brokers" {
  description = "Kafka broker endpoints"
  value       = aws_msk_cluster.kafka.bootstrap_brokers_tls
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}
```

---

## 10. Deployment Pipeline

### Docker Image Building

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source
COPY . .

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start app
CMD ["npm", "run", "start"]
```

### ECR Push

```bash
#!/bin/bash
# push-to-ecr.sh

AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="123456789"
ECR_REPO="psn-app"
IMAGE_TAG="latest"

# Get ECR login
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Build image
docker build -t $ECR_REPO:$IMAGE_TAG .

# Tag for ECR
docker tag $ECR_REPO:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG

# Push
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG

echo "Pushed image to ECR"
```

### ECS Deployment

```bash
#!/bin/bash
# deploy.sh

CLUSTER_NAME="psn-app-cluster"
SERVICE_NAME="psn-service"
REGION="us-east-1"

# Update service to use latest image
aws ecs update-service \
  --cluster $CLUSTER_NAME \
  --service $SERVICE_NAME \
  --region $REGION \
  --force-new-deployment

# Wait for deployment
aws ecs wait services-stable \
  --cluster $CLUSTER_NAME \
  --services $SERVICE_NAME \
  --region $REGION

echo "Deployment complete"
```

### Blue-Green Deployment (Alternative)

```hcl
# Create two task definitions
resource "aws_ecs_task_definition" "app_blue" {
  # Current production version
}

resource "aws_ecs_task_definition" "app_green" {
  # New version to test
}

# Switch traffic between them using ALB
resource "aws_lb_target_group" "blue" {
  name = "psn-blue"
  # ...
}

resource "aws_lb_target_group" "green" {
  name = "psn-green"
  # ...
}

# ALB rule: 90% → blue, 10% → green
resource "aws_lb_listener_rule" "canary" {
  listener_arn = aws_lb_listener.http.arn

  action {
    type = "forward"
    forward {
      target_group {
        arn    = aws_lb_target_group.blue.arn
        weight = 90
      }
      target_group {
        arn    = aws_lb_target_group.green.arn
        weight = 10
      }
    }
  }
}
```

---

## 11. Monitoring & Observability

### CloudWatch Metrics

```hcl
# Create dashboard
resource "aws_cloudwatch_dashboard" "psn" {
  dashboard_name = "psn-app-dashboard"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric"
        properties = {
          metrics = [
            # ECS metrics
            ["AWS/ECS", "CPUUtilization", { stat = "Average" }],
            ["AWS/ECS", "MemoryUtilization", { stat = "Average" }],
            # ALB metrics
            ["AWS/ApplicationELB", "TargetResponseTime"],
            ["AWS/ApplicationELB", "RequestCount"],
            ["AWS/ApplicationELB", "HealthyHostCount"],
            ["AWS/ApplicationELB", "UnHealthyHostCount"],
            # ElastiCache metrics
            ["AWS/ElastiCache", "CPUUtilization"],
            ["AWS/ElastiCache", "SwapUsage"],
            ["AWS/ElastiCache", "Evictions"],
          ]
          period = 60
          stat   = "Average"
          region = "us-east-1"
        }
      }
    ]
  })
}
```

### Key Metrics to Monitor

```
ECS Task Metrics:
├─ CPU Utilization: Should stay 40-70%
├─ Memory Utilization: Should stay 50-80%
└─ Task Count: Should match desired_count

ALB Metrics:
├─ Request Count: Requests per second
├─ Target Response Time: P50, P95, P99
├─ Healthy Host Count: Number of healthy tasks
└─ HTTP 5XX: Server errors

ElastiCache Metrics:
├─ CPU Utilization: Should stay <50%
├─ Evictions: Indicates cache size issues
├─ Cache Hit Rate: Should be >80%
└─ Replication Lag: Should be <10ms

MSK Metrics:
├─ KafkaProduceLocalTimeMean: Should be <100ms
├─ BytesOutPerSec: Throughput
└─ UnderReplicatedPartitions: Should be 0
```

### CloudWatch Alarms

```hcl
# Alert on high CPU
resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  alarm_name          = "psn-ecs-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "ECS CPU > 80%"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Alert on ElastiCache evictions
resource "aws_cloudwatch_metric_alarm" "redis_evictions" {
  alarm_name          = "psn-redis-evictions"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Evictions"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Sum"
  threshold           = 100
  alarm_description   = "Redis evicting data (need bigger cache)"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
```

### Log Aggregation

```hcl
resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/psn-app"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "kafka" {
  name              = "/aws/msk/psn-app"
  retention_in_days = 7
}

# Log queries
# Find errors in last hour
aws logs filter-log-events \
  --log-group-name /ecs/psn-app \
  --filter-pattern "ERROR" \
  --start-time $(date -d "1 hour ago" +%s)000

# Get request latency statistics
aws logs get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name TargetResponseTime \
  --dimensions Name=LoadBalancer,Value=app/psn-alb/* \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-02T00:00:00Z \
  --period 300 \
  --statistics Average,Maximum
```

### X-Ray Tracing

```hcl
# Enable X-Ray in ECS
resource "aws_ecs_task_definition" "app" {
  # ... other config ...

  container_definitions = jsonencode([
    {
      # ... app container ...
    },
    {
      name      = "xray-daemon"
      image     = "public.ecr.aws/xray/aws-xray-daemon:latest"
      essential = false
      port_mappings = [{
        containerPort = 2000
        protocol      = "udp"
      }]
    }
  ])
}
```

---

## 12. Disaster Recovery

### RDS Backups

```hcl
resource "aws_db_instance" "main" {
  allocated_storage    = 100
  storage_type         = "gp3"
  engine               = "postgres"
  engine_version       = "15"
  instance_class       = "db.t3.medium"
  multi_az             = true              # Multi-AZ failover

  # Backups
  backup_retention_period = 7              # Keep 7 days
  backup_window          = "03:00-04:00"

  # Replication
  skip_final_snapshot = false
  final_snapshot_identifier = "psn-final-snapshot"

  # Read replicas
  publicly_accessible = false
  storage_encrypted   = true
}

# Read replica in another region
resource "aws_db_instance" "replica" {
  replicate_source_db = aws_db_instance.main.identifier
  identifier          = "psn-db-replica"

  skip_final_snapshot = true
}
```

### Redis Snapshots

```bash
# Manual snapshot
aws elasticache create-snapshot \
  --replication-group-id psn-redis \
  --snapshot-name psn-redis-backup-$(date +%Y%m%d)

# Restore from snapshot
aws elasticache restore-from-snapshot \
  --replication-group-id psn-redis-restored \
  --snapshot-name psn-redis-backup-20240101
```

### Multi-Region Setup

```
Primary Region (us-east-1):
├─ VPC, ECS, RDS, Redis, Kafka
├─ Active traffic
└─ Continuous replication

Secondary Region (us-west-2):
├─ RDS read replica
├─ Redis replica
└─ Kafka topics replicated
```

---

## 13. Cost Optimization

### Fargate Spot Instances

```hcl
# Use Spot for non-critical workloads
resource "aws_ecs_service" "app" {
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 70  # 70% on-demand
    base              = 1   # Always 1 on-demand
  }

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 30  # 30% spot
  }
}
```

### Reserved Instances

```
For predictable baseline load:
├─ 30% Reserved Instances (40% cheaper)
├─ 50% On-Demand (standard rate)
└─ 20% Spot (70% cheaper)

Monthly estimate:
├─ Compute: $2,500 (ECS Fargate)
├─ Caching: $300 (ElastiCache)
├─ Kafka: $800 (MSK)
├─ Database: $1,200 (RDS)
└─ Total: ~$4,800/month
```

### Optimization Tips

1. **Right-size instances**: Monitor utilization, scale down if <30% used
2. **Use Spot**: For batch jobs, data processing (70% savings)
3. **Reserved Instances**: For baseline 24/7 load (40% savings)
4. **Auto-scaling**: Don't overprovision, let metrics guide sizing
5. **Cache aggressively**: Reduce database queries

---

## Interview Questions: AWS & Infrastructure

### 1. VPC & Networking

**Q: Explain the VPC design and why we use NAT Gateways**

A:
- VPC is an isolated network (10.0.0.0/16)
- Public subnets: ALB only (direct internet access)
- Private subnets: ECS, Redis, Kafka (no public IPs)
- NAT Gateway: Allows private subnets to reach internet for updates/downloads
- Why? Security - no direct internet exposure of app servers

**Q: What happens if a NAT Gateway fails?**

A:
- We have 2 NAT Gateways (one per AZ)
- If AZ-a NAT fails, AZ-b NAT still works
- Private subnets in AZ-a route to AZ-b NAT (slight latency increase)
- Auto Scaling replaces the failed one

**Q: How does security group filtering work?**

A:
```
ALB SG allows: 0.0.0.0/0 → 80,443
ECS SG allows: ALB SG → 4000 (only ALB can reach it)
Redis SG allows: ECS SG → 6379 (only app tasks can reach it)

This creates a chain of trust:
Internet → ALB → ECS → Redis
```

---

### 2. ECS & Containers

**Q: What's the difference between ECS, EKS, and App Runner?**

A:
```
ECS (Elastic Container Service):
├─ AWS-native container orchestration
├─ EC2 or Fargate launch types
├─ Good for: Complex multi-container apps
└─ Cost: Cheaper than EKS

EKS (Elastic Kubernetes Service):
├─ Managed Kubernetes
├─ Industry standard, portable
├─ Good for: Complex microservices, multiple teams
└─ Cost: More expensive, steeper learning curve

App Runner:
├─ Simplest, fully managed
├─ Deploy code directly
├─ Good for: Simple web apps, minimal DevOps
└─ Cost: Most expensive per container
```

**Q: Explain ECS task definition and service**

A:
- **Task Definition**: Blueprint (like Docker Compose)
  - Defines container image, CPU, memory, environment, ports
  - Includes health check, logging config
  - Version-controlled

- **Service**: Long-running task manager
  - Maintains desired count (e.g., always 2 tasks)
  - Auto-restarts failed tasks
  - Integrates with load balancer
  - Handles rolling updates

**Q: How does ECS handle zero-downtime deployments?**

A:
```
1. New task definition version created
2. ALB starts routing traffic to new tasks (10%)
3. Old tasks gradually receive less traffic
4. New tasks receive more traffic (by percentage)
5. Once 100% on new, old tasks terminated
6. If errors detected: Automatic rollback

Total time: ~10 minutes, zero downtime
```

**Q: What's CPU/Memory contention in Fargate?**

A:
- Each task has reserved CPU/memory (512 CPU = 0.5 vCPU)
- Multiple tasks share underlying hardware
- If one task spikes, doesn't affect others (isolated)
- Unlike EC2, can't "steal" CPU from neighbors

---

### 3. Load Balancing

**Q: How does ALB health checking work?**

A:
```
Every 30 seconds:
1. ALB sends GET /health to task:4000
2. Task responds with 200 OK
3. Healthy counter increments (need 2 in a row to mark healthy)

If 3 consecutive failures:
1. Task marked UNHEALTHY
2. ALB stops routing traffic to it
3. ECS Auto Scaling replaces it

This prevents requests to failing tasks.
```

**Q: What are sticky sessions and when do we use them?**

A:
- ALB uses cookies to keep user on same task
- Useful for WebSocket (maintains open connection)
- Also useful for server-side sessions
- Downside: Uneven load distribution if many users on one task

For PSN app: Enable sticky sessions (WebSocket needs it)

**Q: How would you handle SSL/TLS termination?**

A:
```hcl
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS-1-2-2017-01"
  certificate_arn   = aws_acm_certificate.main.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ALB decrypts HTTPS, talks to tasks via HTTP (internal)
# Protects certificate, simplifies task configuration
```

---

### 4. Caching & Redis

**Q: When should we use Redis Replication vs Cluster mode?**

A:
```
Replication (Single Primary):
├─ Dataset < 50 GB
├─ One primary, many read replicas
├─ All writes to primary
├─ Read from replicas (distribute load)
├─ Simpler to manage
└─ Good for: Sessions, caches

Cluster Mode (Sharding):
├─ Dataset > 50 GB
├─ Multiple primaries (shards)
├─ Data automatically sharded
├─ Horizontal scaling
└─ Good for: Large datasets, extreme throughput
```

For PSN: Use Replication (user sessions < 50 GB at scale)

**Q: Explain cache eviction policies**

A:
```
maxmemory-policy options:

1. allkeys-lru (what we use)
   - When full, evict least-recently-used keys
   - Good for caches (don't need specific data)

2. volatile-lru
   - Only evict keys with TTL set
   - Preserve permanent data
   - Good for mixed workloads

3. noeviction
   - Don't evict, return error
   - For critical data (no data loss)
   - App must handle errors

4. random
   - Evict random keys
   - Simple, unpredictable
   - Avoid in production
```

**Q: What does a cache hit ratio of 60% mean?**

A:
- 60% of requests found in cache (fast)
- 40% need database roundtrip (slow)
- Goal: >80% for good performance
- If <80%, might need:
  - Larger cache
  - Better TTL strategy
  - More warming

---

### 5. Message Queues & Kafka

**Q: What's the difference between SQS and Kafka?**

A:
```
SQS (Simple Queue Service):
├─ Simple message queue
├─ Messages deleted after processing
├─ Good for: Task queues, fire-and-forget
├─ No ordering (unless FIFO)
└─ Limited replay

Kafka (Event Streaming):
├─ Distributed event log
├─ Messages retained (days/months)
├─ Good for: Event streaming, analytics
├─ Ordering per partition
├─ Full event replay possible

PSN App uses Kafka because:
- Need event history for analytics
- Need multi-consumer (analytics, notifications)
- Need ordering per user
```

**Q: How does Kafka partition assignment work?**

A:
```
Consumer group: "psn-notification-service" with 3 consumers

Topic: psn.user.events (3 partitions)
├─ Partition 0: Consumer A
├─ Partition 1: Consumer B
└─ Partition 2: Consumer C

If Consumer B dies:
├─ Partitions rebalanced
├─ Partition 1 reassigned to Consumer A
└─ Processing continues (Leader Election)

Key benefit: Exactly-once semantics
- Each partition processed by exactly one consumer
- No duplicate processing
```

**Q: How do you ensure message ordering in Kafka?**

A:
```
1. Use consistent key (e.g., userId)
2. Events with same key → same partition
3. Partition → single consumer
4. Consumer processes in order

Example:
User 123 sends 3 events:
├─ Event 1: login (t=1)
├─ Event 2: play_game (t=2)
└─ Event 3: logout (t=3)

All 3 → Partition 5 (due to hash(userId=123))
Consumer always reads: 1 → 2 → 3 (ordered)

Without keying: Events could arrive out of order
```

---

### 6. Terraform & IaC

**Q: Why use state management in Terraform?**

A:
```
State file (terraform.tfstate):
├─ Records current AWS resources
├─ Maps resource IDs to code
├─ Enables diff (what changed?)
├─ Allows safe deletions

Issues:
├─ State file is sensitive (contains passwords)
├─ If lost: Terraform loses track of resources
├─ Concurrent edits: Race conditions

Solution:
├─ Store in S3 with encryption
├─ Enable versioning (rollback)
├─ Use DynamoDB for locking (prevent concurrent edits)
```

**Q: How do you deploy to multiple environments (dev/staging/prod)?**

A:
```
Approach 1: Variables files
├─ main.tf (same for all)
├─ dev.tfvars (smaller instances)
├─ staging.tfvars (medium instances)
└─ prod.tfvars (large instances)

Usage:
terraform apply -var-file=prod.tfvars

Approach 2: Terraform workspaces
├─ terraform workspace new prod
├─ terraform workspace new dev
├─ terraform apply (only affects current workspace)

We use Approach 1 (easier to review differences)
```

**Q: How do you prevent accidental destruction of production?**

A:
```
Multiple safeguards:

1. Separate AWS accounts
   ├─ Dev/Staging: Lower-priority account
   └─ Prod: Separate account (restricted access)

2. Terraform guards
   ├─ prevent_destroy = true (blocks deletion)
   ├─ Manual approval workflow
   └─ Plan + review before apply

3. IAM permissions
   ├─ Only senior engineers can deploy prod
   ├─ Require MFA for sensitive operations
   └─ Audit logging of all changes

Example:
resource "aws_rds_instance" "main" {
  lifecycle {
    prevent_destroy = true  # Prevent accidental deletion
  }
}
```

---

### 7. Monitoring & Debugging

**Q: How would you debug a task not starting?**

A:
```
1. Check ECS task logs
   aws logs tail /ecs/psn-app --follow

2. Check task events
   aws ecs describe-tasks \
     --cluster psn-cluster \
     --tasks arn:aws:ecs:...

3. Common issues:
   ├─ Image not in ECR: Permission issue
   ├─ Out of memory: Task too small
   ├─ Port already in use: Task crashed
   ├─ Environment variables missing: Check task def
   └─ Security group blocks traffic: Check inbound rules

4. CloudWatch metrics
   ├─ Task launch failures
   ├─ Task stop reasons
   └─ Resource constraints
```

**Q: How would you debug slow requests?**

A:
```
1. Check ALB metrics
   ├─ TargetResponseTime (p50, p95, p99)
   ├─ RequestCount
   └─ HealthyHostCount

2. Check ECS task metrics
   ├─ CPUUtilization (hitting ceiling?)
   ├─ MemoryUtilization
   └─ Disk usage

3. Check application logs
   grep "duration:" /ecs/logs
   # Find requests taking >100ms

4. Check downstream
   ├─ Database query time
   ├─ Redis latency
   ├─ Kafka lag
   └─ Third-party API calls

5. Use X-Ray
   aws xray get-trace-summaries \
     --start-time ... --end-time ...
   # Visualize latency at each step
```

**Q: How do you set up alerting for production?**

A:
```hcl
# Create SNS topic for alerts
resource "aws_sns_topic" "alerts" {
  name = "psn-alerts"
}

# Subscribe team
resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = "ops-team@company.com"
}

# Alert on CPU spike
resource "aws_cloudwatch_metric_alarm" "high_cpu" {
  alarm_name          = "psn-cpu-alarm"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 85
  metric_name         = "CPUUtilization"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# PagerDuty integration
resource "aws_sns_topic_subscription" "pagerduty" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "https"
  endpoint  = "https://events.pagerduty.com/..."
}
```

---

### 8. Scaling & Performance

**Q: At what point would you switch from Replication to Cluster mode Redis?**

A:
```
Decision matrix:

Dataset Size:
├─ < 10 GB: Replication (fine)
├─ 10-50 GB: Replication (still okay, t3.large)
└─ > 50 GB: Cluster (must shard)

Throughput:
├─ < 100k ops/sec: Replication (primary handles)
├─ 100k-500k ops/sec: Watch primary CPU
└─ > 500k ops/sec: Need Cluster (shard writes)

Cost vs Complexity:
├─ Replication: Simpler, cheaper
└─ Cluster: More complex, scales better

PSN at scale (100M users):
├─ 20-30 GB session data
├─ 200k ops/sec peak
└─ Stays on Replication (single high-capacity node)
```

**Q: How would you scale Kafka for 1M messages/sec?**

A:
```
Current setup:
├─ 3 brokers
├─ 3 partitions per topic
└─ ~300k msgs/sec (100k per broker)

To scale to 1M msgs/sec:

Step 1: Add partitions (9 total)
├─ Topics spread over 9 partitions
├─ Each broker handles 3 partitions
├─ Throughput ×3

Step 2: Add brokers (6 total)
├─ Each partition replicated
├─ 18 total partitions (9 primary, 9 replicas)
├─ Capacity ×2

Result:
├─ 6 brokers
├─ 9 partitions
├─ 1M msgs/sec (capacity)

Trade-off: More brokers = more complexity
Alternative: Use Kafka topics with compression
```

**Q: How would you handle a cache stampede?**

A:
```
Cache stampede: Many requests for expired key, all hit DB

Scenario:
├─ Key expires at t=10s
├─ 1000 requests arrive at t=10.001s
├─ All miss cache, all query database
├─ Database overloaded

Solution 1: Probabilistic early expiration
```typescript
const TTL = 3600;  // 1 hour
const WINDOW = 300; // 5 minute recompute window

const cachedValue = await redis.get(key);
if (!cachedValue) {
  return fetchFromDB(); // Miss, fetch
}

const ttl = await redis.ttl(key);
if (ttl < WINDOW && Math.random() < 0.1) {
  // 10% chance to refresh early if < 5 min left
  fetchFromDBAsync(); // Async refresh
}

return cachedValue; // Serve from cache
```

Solution 2: Lock-based recomputation
```typescript
const { acquired, lockId } = await lock.acquire(`recompute:${key}`);
if (acquired) {
  // We win the lottery, recompute
  const value = await fetchFromDB();
  await redis.set(key, value, 'EX', TTL);
  await lock.release(key, lockId);
} else {
  // Others recomputing, wait and serve cache
  await sleep(100);
  return await redis.get(key);
}
```

Solution 3: Increase TTL gradually
- Start with TTL=300s
- If cache miss at high traffic: Set TTL=3600s
- Reduces miss rate during spikes
```

---

### 9. Cost & Optimization

**Q: How would you reduce AWS costs by 40%?**

A:
```
1. Reserved Instances (30% savings)
   ├─ Buy 1-year commitment for baseline load
   ├─ Save $750/month on compute
   └─ Still use on-demand for spikes

2. Spot Instances (70% savings)
   ├─ Use for non-critical batch jobs
   ├─ Set up auto-recovery
   └─ Save $500/month on peaks

3. Right-sizing
   ├─ Monitor utilization
   ├─ If always <40% CPU: downsize
   ├─ If always >80% CPU: upsize
   └─ Save $300/month from better matches

4. Storage optimization
   ├─ Delete old snapshots (keep 7 days)
   ├─ Compress logs before storage
   ├─ Move old data to Glacier
   └─ Save $200/month on storage

5. Network optimization
   ├─ Use VPC endpoints (free instead of NAT)
   ├─ Cache more (reduce DB queries)
   ├─ Compress responses (smaller data transfer)
   └─ Save $150/month on data transfer

Total: ~$1,900/month savings (40% reduction)
```

**Q: Trade-off analysis: When should we use RDS vs DynamoDB?**

A:
```
RDS (Relational):
├─ Cost: $200-500/month (t3.small)
├─ Good for: Complex queries, transactions, relational data
├─ Scaling: Vertical (bigger instance) then read replicas
├─ Multi-AZ: Yes (automatic failover)
├─ Backup: Automatic

DynamoDB (NoSQL):
├─ Cost: Pay-per-request (~$0.25 per million reads)
├─ Good for: Simple key-value, massive scale, low latency
├─ Scaling: Automatic, unlimited
├─ Multi-AZ: Automatic
├─ Backup: Point-in-time restore

PSN app uses RDS because:
├─ Complex schema (users, friends, games, sessions)
├─ Join queries (user + friend data)
├─ ACID transactions needed
├─ Multi-master replication possible
└─ Cost not prohibitive at scale
```

---

### 10. Security & Compliance

**Q: How would you secure sensitive data in transit?**

A:
```
1. ALB HTTPS
   ├─ TLS 1.2 minimum
   ├─ Strong ciphers only
   ├─ AWS ACM certificate (auto-renewed)
   └─ Terminates at ALB (not app)

2. Internal services
   ├─ ElastiCache: TLS encryption
   ├─ RDS: SSL/TLS required
   ├─ MSK: TLS encryption + SCRAM auth
   └─ All internal traffic encrypted

3. VPC endpoints
   ├─ Access S3 without leaving VPC
   ├─ Access DynamoDB without leaving VPC
   └─ No public internet exposure

Implementation:
resource "aws_elasticache_replication_group" "redis" {
  transit_encryption_enabled = true  # Encrypt data in transit
  at_rest_encryption_enabled = true  # Encrypt stored
}
```

**Q: How would you implement least privilege access?**

A:
```
1. IAM Roles (not access keys)
   ├─ ECS tasks: assume task role
   ├─ Gets temporary credentials
   ├─ Auto-rotated every hour
   └─ No stored passwords

2. Specific permissions
   resource "aws_iam_role_policy" "ecs_task" {
     statement {
       effect = "Allow"
       actions = [
         "s3:GetObject",        # Can read
         "s3:PutObject",        # Can write
       ]
       resources = [
         "arn:aws:s3:::psn-app-bucket/*"  # Only this bucket
       ]
     }
   }

3. Network policies
   ├─ Security groups: Explicit allow lists
   ├─ VPC endpoints: No internet exposure
   └─ Private subnets: No public IPs

4. Audit logging
   ├─ CloudTrail: Who did what when
   ├─ VPC Flow Logs: Network traffic
   ├─ S3 access logging: Data access
   └─ RDS audit: Database changes
```

---

## Summary & Decision Tree

### Choosing AWS Services

```
Application Container?
├─ Simple app → App Runner
├─ Complex app → ECS Fargate
└─ Microservices → EKS

Database?
├─ Relational data → RDS (PostgreSQL/MySQL)
├─ Simple key-value → DynamoDB
└─ Graph data → Neptune

Caching?
├─ Small dataset → ElastiCache Replication
├─ Large dataset → ElastiCache Cluster
└─ Session only → ElastiCache Replication

Messaging?
├─ Task queue → SQS
├─ Event streaming → MSK (Kafka)
└─ Real-time notifications → SNS

Load Balancing?
├─ HTTP/HTTPS → ALB (what we use)
├─ TCP/UDP → NLB
└─ Content-based → ALB

Monitoring?
├─ Metrics → CloudWatch
├─ Logs → CloudWatch Logs
├─ Tracing → X-Ray
└─ Alerts → SNS/CloudWatch Alarms
```

### Deployment Checklist

Before deploying to production:

```
Infrastructure:
[ ] Terraform plan reviewed
[ ] State backed up (S3 + versioning)
[ ] DynamoDB lock table created
[ ] Security groups locked down
[ ] Multi-AZ enabled

Application:
[ ] Docker image scanned for vulnerabilities
[ ] Health check endpoint working
[ ] Environment variables set
[ ] Database migrations run

Monitoring:
[ ] CloudWatch alarms configured
[ ] Log retention set
[ ] Metrics dashboard created
[ ] Pagerduty integration tested

Scaling:
[ ] Auto-scaling policies configured
[ ] Load test passed
[ ] Cost estimates reviewed
[ ] Rollback plan documented
```

---

## References

- [AWS ECS Best Practices](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_best_practices.html)
- [Terraform AWS Provider Docs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
- [Redis Cluster Tutorial](https://redis.io/topics/cluster-tutorial)
- [Apache Kafka Architecture](https://kafka.apache.org/documentation/#gettingStarted)
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)

---

**Next: Read [Interview Questions](./11-interview-questions.md) for 50+ common backend interview questions with answers.**

Good luck with your AWS infrastructure! 🚀
