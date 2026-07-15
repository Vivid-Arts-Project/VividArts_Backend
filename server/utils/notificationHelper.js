import React from 'react';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

export const NotificationContainer = () => {
  return (
    <ToastContainer 
      position="top-right" 
      autoClose={5000} 
      hideProgressBar={false}
      newestOnTop={false}
      closeOnClick
      rtl={false}
      pauseOnFocusLoss
      draggable
      pauseOnHover
    />
  );
};

export const showNotification = (type, message) => {
  switch (type) {
    case 'success':
      toast.success(`🟢 ${message}`);
      break;

    case 'error':
      toast.error(`🔴 ${message}`);
      break;

    case 'order_success':
      toast.success(`🎉 SUCCESS: ${message}`, {
        icon: "🎨",
        style: { background: "#e6fffa", color: "#006d5b", fontWeight: "bold" }
      });
      break;

    case 'status_update':
      toast.info(`📅 UPDATE: ${message}`, {
        icon: "⏱️",
        style: { background: "#ebf8ff", color: "#2b6cb0" }
      });
      break;

    default:
      toast(message);
  }
};