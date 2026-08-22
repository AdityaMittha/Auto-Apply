#!/bin/bash
# Script to create and configure S3 bucket for Auto-Apply bot resumes and logs

set -e

BUCKET_NAME="${1:-auto-apply-aditya-mittha}"
REGION="ap-south-1"
PROFILE="auto-apply"

echo "=========================================="
echo "☁️  Setting up S3 Bucket: $BUCKET_NAME"
echo "=========================================="

# Check if bucket exists
if aws s3api head-bucket --bucket "$BUCKET_NAME" --profile "$PROFILE" --region "$REGION" 2>/dev/null; then
  echo "✅ Bucket $BUCKET_NAME already exists."
else
  echo "🚀 Creating bucket $BUCKET_NAME in $REGION..."
  aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION" \
    --profile "$PROFILE"
  echo "✅ Bucket created successfully."
fi

# Enable default encryption
echo "🔒 Enabling AES-256 server-side encryption..."
aws s3api put-bucket-encryption \
  --bucket "$BUCKET_NAME" \
  --server-side-encryption-configuration '{"Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}' \
  --profile "$PROFILE" \
  --region "$REGION"

# Block public access (only access via IAM and presigned URLs)
echo "🛡️  Configuring public access block..."
aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
  --profile "$PROFILE" \
  --region "$REGION"

echo "=========================================="
echo "🎉 S3 Bucket Configuration Complete!"
echo "Bucket: s3://$BUCKET_NAME"
echo "=========================================="
