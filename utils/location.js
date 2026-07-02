// Calculate distance between two coordinates using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
          Math.cos(φ1) * Math.cos(φ2) *
          Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  const distance = R * c; // Distance in meters
  return Math.round(distance);
}

// Validate if location is within allowed radius
function isLocationValid(userLat, userLon, officeLat, officeLon, allowedRadius) {
  const distance = calculateDistance(userLat, userLon, officeLat, officeLon);
  const isValid = distance <= allowedRadius;
  
  console.log(`Location validation: distance=${distance}m, radius=${allowedRadius}m, isValid=${isValid}`);
  
  return {
    isValid: isValid,
    distance: distance,
    allowedRadius: allowedRadius
  };
}

module.exports = {
  calculateDistance,
  isLocationValid
};