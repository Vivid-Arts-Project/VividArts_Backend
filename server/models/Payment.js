module.exports = (sequelize, DataTypes) => {
  const Payment = sequelize.define('Payment', {
    paymentId: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    orderId: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    currency: {
        type: DataTypes.STRING,
        defaultValue: 'LKR'
    },
    paymentMethod: {
        type: DataTypes.ENUM('card', 'bank'),
        allowNull: false
    },
    status: {
        type: DataTypes.ENUM('pending', 'completed', 'failed'),
        defaultValue: 'pending'
    },
    transactionId: {
        type: DataTypes.STRING,
        allowNull: true
    },
    payherePaymentId: {
        type: DataTypes.STRING,
        allowNull: true
    },
    payhereMd5sig: {
        type: DataTypes.STRING,
        allowNull: true
    },
    cardLast4: {
        type: DataTypes.STRING(4),
        allowNull: true
    },
    cardHolderName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    bankName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    bankReference: {
        type: DataTypes.STRING,
        allowNull: true
    },
    metadata: {
        type: DataTypes.JSON,
        allowNull: true
    }
    });

    return Payment;
};
