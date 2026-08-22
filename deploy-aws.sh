#!/bin/bash
# ============================================================
#  Auto-Apply EC2 Deployment Script
#  Provisions a t2.micro instance in ap-south-1 (Mumbai)
#  with security group, SSH key pair, and Elastic IP.
#
#  Prerequisites:
#    aws configure --profile auto-apply
#
#  Usage: chmod +x deploy-aws.sh && ./deploy-aws.sh
# ============================================================

set -euo pipefail

# --- Configuration ---
PROFILE="auto-apply"
REGION="ap-south-1"
INSTANCE_TYPE="t3.micro"
KEY_NAME="auto-apply-key"
KEY_FILE="./${KEY_NAME}.pem"
SG_NAME="auto-apply-sg"
INSTANCE_NAME="Auto-Apply-Bot"
VOLUME_SIZE=20  # GB

echo "=========================================="
echo "🚀 Auto-Apply EC2 Deployment"
echo "   Region:   ${REGION}"
echo "   Type:     ${INSTANCE_TYPE}"
echo "   Storage:  ${VOLUME_SIZE}GB gp3"
echo "=========================================="

# --- Helper: run AWS CLI with profile & region ---
aws_cmd() {
  aws "$@" --profile "$PROFILE" --region "$REGION"
}

# --- 1. Create SSH Key Pair (if needed) ---
echo ""
echo "🔑 Step 1/6: SSH Key Pair..."
if [ -f "$KEY_FILE" ]; then
  echo "   Key file ${KEY_FILE} already exists, skipping creation."
else
  # Check if key exists in AWS
  if aws_cmd ec2 describe-key-pairs --key-names "$KEY_NAME" 2>/dev/null; then
    echo "   Key '${KEY_NAME}' exists in AWS but not locally."
    echo "   ⚠️  Delete it in AWS Console and re-run, or place your .pem file here."
    exit 1
  fi
  aws_cmd ec2 create-key-pair \
    --key-name "$KEY_NAME" \
    --query 'KeyMaterial' \
    --output text > "$KEY_FILE"
  chmod 400 "$KEY_FILE"
  echo "   ✅ Created ${KEY_FILE} (keep this safe!)"
fi

# --- 2. Create Security Group ---
echo ""
echo "🛡️  Step 2/6: Security Group..."

# Get VPC ID (default VPC)
VPC_ID=$(aws_cmd ec2 describe-vpcs \
  --filters "Name=isDefault,Values=true" \
  --query "Vpcs[0].VpcId" --output text)
echo "   Default VPC: ${VPC_ID}"

# Check if SG already exists
SG_ID=$(aws_cmd ec2 describe-security-groups \
  --filters "Name=group-name,Values=${SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
  --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || echo "None")

if [ "$SG_ID" != "None" ] && [ "$SG_ID" != "" ]; then
  echo "   Security group ${SG_NAME} already exists: ${SG_ID}"
else
  SG_ID=$(aws_cmd ec2 create-security-group \
    --group-name "$SG_NAME" \
    --description "Auto-Apply Bot - SSH + VNC access" \
    --vpc-id "$VPC_ID" \
    --query "GroupId" --output text)
  echo "   ✅ Created security group: ${SG_ID}"

  # Get current public IP for restricted access
  MY_IP=$(curl -s https://checkip.amazonaws.com)/32
  echo "   Your IP: ${MY_IP}"

  # SSH access
  aws_cmd ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --protocol tcp --port 22 --cidr "$MY_IP" \
    --tag-specifications "ResourceType=security-group-rule,Tags=[{Key=Name,Value=SSH}]"
  echo "   ✅ SSH (port 22) allowed from ${MY_IP}"

  # VNC access
  aws_cmd ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --protocol tcp --port 5901 --cidr "$MY_IP" \
    --tag-specifications "ResourceType=security-group-rule,Tags=[{Key=Name,Value=VNC}]"
  echo "   ✅ VNC (port 5901) allowed from ${MY_IP}"
fi

# --- 3. Find latest Amazon Linux 2023 AMI ---
echo ""
echo "🔍 Step 3/6: Finding latest Amazon Linux 2023 AMI..."
AMI_ID=$(aws_cmd ec2 describe-images \
  --owners amazon \
  --filters \
    "Name=name,Values=al2023-ami-2023.*-x86_64" \
    "Name=state,Values=available" \
  --query "sort_by(Images, &CreationDate)[-1].ImageId" \
  --output text)
echo "   AMI: ${AMI_ID}"

# --- 4. Launch EC2 Instance ---
echo ""
echo "🖥️  Step 4/6: Launching EC2 instance..."

# Check if instance with this name already exists and is running
EXISTING_ID=$(aws_cmd ec2 describe-instances \
  --filters "Name=tag:Name,Values=${INSTANCE_NAME}" "Name=instance-state-name,Values=running,stopped" \
  --query "Reservations[0].Instances[0].InstanceId" --output text 2>/dev/null || echo "None")

if [ "$EXISTING_ID" != "None" ] && [ "$EXISTING_ID" != "" ]; then
  echo "   ⚠️  Instance '${INSTANCE_NAME}' already exists: ${EXISTING_ID}"
  echo "   Skipping launch. To redeploy, terminate it first."
  INSTANCE_ID="$EXISTING_ID"
else
  INSTANCE_ID=$(aws_cmd ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":${VOLUME_SIZE},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${INSTANCE_NAME}}]" \
    --query "Instances[0].InstanceId" --output text)
  echo "   ✅ Launched instance: ${INSTANCE_ID}"

  # Wait for running state
  echo "   ⏳ Waiting for instance to enter 'running' state..."
  aws_cmd ec2 wait instance-running --instance-ids "$INSTANCE_ID"
  echo "   ✅ Instance is running!"
fi

# --- 5. Allocate and associate Elastic IP ---
echo ""
echo "🌐 Step 5/6: Elastic IP..."

# Check if instance already has an EIP
CURRENT_EIP=$(aws_cmd ec2 describe-addresses \
  --filters "Name=instance-id,Values=${INSTANCE_ID}" \
  --query "Addresses[0].PublicIp" --output text 2>/dev/null || echo "None")

if [ "$CURRENT_EIP" != "None" ] && [ "$CURRENT_EIP" != "" ]; then
  EIP="$CURRENT_EIP"
  echo "   Elastic IP already associated: ${EIP}"
else
  ALLOC_ID=$(aws_cmd ec2 allocate-address \
    --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=${INSTANCE_NAME}-EIP}]" \
    --query "AllocationId" --output text)
  EIP=$(aws_cmd ec2 describe-addresses \
    --allocation-ids "$ALLOC_ID" \
    --query "Addresses[0].PublicIp" --output text)

  # Wait a moment for the instance to be fully ready for association
  sleep 5

  aws_cmd ec2 associate-address \
    --instance-id "$INSTANCE_ID" \
    --allocation-id "$ALLOC_ID"
  echo "   ✅ Elastic IP: ${EIP}"
fi

# --- 6. Wait for SSH to be ready ---
echo ""
echo "🔌 Step 6/6: Waiting for SSH to become available..."
for i in $(seq 1 30); do
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i "$KEY_FILE" ec2-user@"$EIP" "echo ok" 2>/dev/null; then
    echo "   ✅ SSH is ready!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "   ⚠️  SSH not responding after 30 attempts. Check security group."
    echo "   Try manually: ssh -i ${KEY_FILE} ec2-user@${EIP}"
  fi
  sleep 10
done

# --- Done ---
echo ""
echo "=========================================="
echo "🎉 Deployment Complete!"
echo "=========================================="
echo ""
echo "  Instance ID : ${INSTANCE_ID}"
echo "  Public IP   : ${EIP}"
echo "  Region      : ${REGION}"
echo "  Key File    : ${KEY_FILE}"
echo ""
echo "  SSH Command:"
echo "    ssh -i ${KEY_FILE} ec2-user@${EIP}"
echo ""
echo "  Next steps:"
echo "    1. SSH into the instance"
echo "    2. Run server-setup.sh (uploaded via transfer-data.sh)"
echo "    3. Run transfer-data.sh to upload your data"
echo "    4. Run cron-setup.sh to activate the schedule"
echo ""

# Save connection info for other scripts
cat > .deploy-info <<EOF
DEPLOY_IP=${EIP}
DEPLOY_KEY=${KEY_FILE}
DEPLOY_USER=ec2-user
DEPLOY_INSTANCE_ID=${INSTANCE_ID}
DEPLOY_REGION=${REGION}
DEPLOY_PROFILE=${PROFILE}
EOF
echo "   Connection info saved to .deploy-info"
